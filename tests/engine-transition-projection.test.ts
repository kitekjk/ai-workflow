import { describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { runRunnerWorkerOnce } from "../src/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../src/prd-confirmation/scheduler";
import { runEngineStep } from "../src/prd-confirmation/workflow-engine";
import { createEngineTransitionCommandInput } from "../src/workflow-api/engine-transition-projection";

describe("engine transition projection", () => {
  it("projects engine step metadata into one transition command input", async () => {
    const fixture = createPrdConfirmationFixture();
    const now = new Date("2026-05-20T00:00:00.000Z");
    await fixture.workflow.intakePrdTicket("PRD-100");

    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, fixture.skills);
    const engineStep = await runEngineStep(fixture.store);

    expect(createEngineTransitionCommandInput(fixture.store, engineStep, now)).toMatchObject({
      transitionType: "prd_draft_generated",
      affectedWorkItemIds: ["wi_1"],
      affectedDocumentIds: ["doc_wi_1"],
      createdWorkItemIds: [],
      workItemState: {
        workItemId: "wi_1",
        before: "draft_requested",
        after: "evaluating"
      },
      externalIssueStatus: {
        issueKey: "PRD-100",
        before: "drafting",
        after: "drafting"
      },
      processedResult: {
        jobId: "job_1",
        jobType: "prd.generate_draft",
        primaryJiraKey: "PRD-100",
        status: "succeeded"
      },
      documents: [
        {
          id: "doc_wi_1",
          status: "quality_review"
        }
      ],
      jobs: [
        {
          runId: "run_1",
          job: {
            id: "job_2",
            jobType: "prd.evaluate_quality"
          }
        }
      ],
      now
    });
  });

  it("returns undefined for an idle engine step", () => {
    expect(
      createEngineTransitionCommandInput(
        createPrdConfirmationFixture().store,
        {
          progressed: false,
          affectedWorkItemIds: [],
          affectedDocumentIds: [],
          createdJobIds: [],
          createdWorkItemIds: []
        },
        new Date("2026-05-20T00:00:00.000Z")
      )
    ).toBeUndefined();
  });
});
