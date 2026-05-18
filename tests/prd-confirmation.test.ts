import { describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { runEngineOnce } from "../src/prd-confirmation/workflow-engine";
import { runRunnerWorkerOnce } from "../src/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../src/prd-confirmation/scheduler";

describe("PRD confirmation workflow", () => {
  it("creates a PRD draft job from an existing planner-owned PRD Jira ticket", async () => {
    const fixture = createPrdConfirmationFixture();

    const result = await fixture.workflow.intakePrdTicket("PRD-100");

    expect(result.status).toBe("accepted");
    expect(fixture.store.workItems).toHaveLength(1);
    expect(fixture.store.agentJobs).toMatchObject([
      {
        jobType: "prd.generate_draft",
        primaryJiraKey: "PRD-100",
        status: "pending"
      }
    ]);
    expect(fixture.store.workItemJiraLinks).toEqual([
      { workItemId: "wi_1", jiraKey: "PRD-100", role: "primary" },
      { workItemId: "wi_1", jiraKey: "OPS-1", role: "source_request" },
      { workItemId: "wi_1", jiraKey: "OPS-2", role: "source_request" }
    ]);
  });

  it("runs draft generation as one job and creates a separate quality evaluation job on the same PRD ticket", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");

    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, fixture.skills);
    await runEngineOnce(fixture.store);

    expect(fixture.store.agentJobs.map((job) => [job.jobType, job.primaryJiraKey, job.status])).toEqual([
      ["prd.generate_draft", "PRD-100", "succeeded"],
      ["prd.evaluate_quality", "PRD-100", "pending"]
    ]);
    expect(fixture.store.artifacts).toMatchObject([
      {
        type: "prd_markdown",
        location: "git",
        url: "https://git.example.com/prd/prds/PRD-100.md"
      },
      {
        type: "prd_wiki_page",
        location: "wiki",
        url: "https://wiki.example.com/prd/PRD-100"
      }
    ]);
  });

  it("marks PRD as needs_revision after a failed quality gate and does not auto-create a revision job", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    await fixture.workflow.intakePrdTicket("PRD-100");

    await fixture.runUntilIdle();

    expect(fixture.store.externalIssues.get("PRD-100")?.status).toBe("needs_revision");
    expect(fixture.store.agentJobs.map((job) => job.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality"
    ]);
    expect(fixture.store.agentJobResults.at(-1)?.output).toMatchObject({
      status: "needs_revision",
      missingInformation: ["Success metric is missing"],
      clarificationQuestions: ["What measurable outcome should this PRD target?"]
    });
  });

  it("applies explicit wiki/Jira feedback as one revision job and re-evaluates quality", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    await fixture.workflow.requestFeedbackRevision("PRD-100", {
      requestedBy: "planner@example.com",
      feedback: "Add success metric: reduce repeated FAQ handling time by 30%."
    });
    fixture.skills.qualityPasses = true;
    await fixture.runUntilIdle();

    expect(fixture.store.agentJobs.map((job) => job.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.apply_feedback_revision",
      "prd.evaluate_quality"
    ]);
    expect(fixture.store.externalIssues.get("PRD-100")?.status).toBe("awaiting_approval");
  });
});
