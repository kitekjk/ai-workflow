import { describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { createGenericPrdSnapshot } from "../src/prd-confirmation/generic-adapter";
import { runEngineOnce, runEngineStep } from "../src/prd-confirmation/workflow-engine";
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

  it("rejects PRD intake unless the Jira ticket is in the requested status", async () => {
    const fixture = createPrdConfirmationFixture();
    fixture.store.externalIssues.get("PRD-100")!.status = "drafting";

    await expect(fixture.workflow.intakePrdTicket("PRD-100")).rejects.toThrow(
      "PRD Jira ticket is not ready for intake: PRD-100"
    );
    expect(fixture.store.workItems).toHaveLength(0);
    expect(fixture.store.agentJobs).toHaveLength(0);
  });

  it("accepts PRD intake from the Jira display status used in the plan", async () => {
    const fixture = createPrdConfirmationFixture();
    fixture.store.externalIssues.get("PRD-100")!.status = "PRD 요청";

    await expect(fixture.workflow.intakePrdTicket("PRD-100")).resolves.toEqual({ status: "accepted" });
    expect(fixture.store.workItems).toHaveLength(1);
    expect(fixture.store.externalIssues.get("PRD-100")?.status).toBe("drafting");
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

  it("returns engine step metadata for processed result transitions", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");

    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, fixture.skills);

    const step = await runEngineStep(fixture.store);

    expect(step).toMatchObject({
      progressed: true,
      transitionType: "prd_draft_generated",
      updatedWorkItemId: "wi_1",
      affectedWorkItemIds: ["wi_1"],
      affectedDocumentIds: ["doc_wi_1"],
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
      createdJobIds: ["job_2"],
      createdWorkItemIds: [],
      processedResult: {
        jobId: "job_1",
        jobType: "prd.generate_draft",
        processed: true
      }
    });
  });

  it("returns idle engine metadata when there is no unprocessed result", async () => {
    const fixture = createPrdConfirmationFixture();

    await expect(runEngineStep(fixture.store)).resolves.toEqual({
      progressed: false,
      affectedWorkItemIds: [],
      affectedDocumentIds: [],
      createdJobIds: [],
      createdWorkItemIds: []
    });
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

  it("creates a downstream routing job after PRD approval and starts the routed HLD document", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    const prdWorkItem = fixture.store.workItems[0];
    prdWorkItem.state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";

    const routing = fixture.workflow.requestDownstreamRouting("PRD-100", {
      requestedBy: "planner@example.com",
      now: new Date("2026-05-20T00:00:00.000Z")
    });
    const duplicateRouting = fixture.workflow.requestDownstreamRouting("PRD-100");

    expect(routing).toEqual({ status: "accepted", jobId: "job_3" });
    expect(duplicateRouting).toEqual({ status: "already_scheduled", jobId: "job_3" });

    await fixture.runUntilIdle();

    expect(fixture.store.workItems).toMatchObject([
      {
        id: "wi_1",
        artifactType: "prd",
        state: "approved"
      },
      {
        id: "wi_2",
        artifactType: "hld",
        parentWorkItemId: "wi_1",
        primaryJiraKey: "PRD-100-HLD-1",
        state: "awaiting_approval"
      }
    ]);
    expect(fixture.store.agentJobs.map((job) => [job.jobType, job.primaryJiraKey, job.status])).toEqual([
      ["prd.generate_draft", "PRD-100", "succeeded"],
      ["prd.evaluate_quality", "PRD-100", "succeeded"],
      ["prd.route_downstream", "PRD-100", "succeeded"],
      ["document.generate", "PRD-100-HLD-1", "succeeded"],
      ["document.evaluate", "PRD-100-HLD-1", "succeeded"]
    ]);
  });

  it("fans out an approved HLD into multiple LLD document jobs", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const hldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "hld");
    expect(hldWorkItem).toMatchObject({
      primaryJiraKey: "PRD-100-HLD-1",
      state: "awaiting_approval"
    });

    hldWorkItem!.state = "approved";
    const fanOut = fixture.workflow.requestDocumentFanOut(hldWorkItem!.primaryJiraKey, {
      requestedBy: "architect@example.com"
    });
    const duplicateFanOut = fixture.workflow.requestDocumentFanOut(hldWorkItem!.primaryJiraKey);
    await fixture.runUntilIdle();

    expect(fanOut).toEqual({ status: "accepted", jobId: "job_6" });
    expect(duplicateFanOut).toEqual({ status: "already_scheduled", jobId: "job_6" });
    expect(
      fixture.store.workItems
        .filter((workItem) => workItem.artifactType === "lld")
        .map((workItem) => ({
          parentWorkItemId: workItem.parentWorkItemId,
          primaryJiraKey: workItem.primaryJiraKey,
          state: workItem.state
        }))
    ).toEqual([
      {
        parentWorkItemId: "wi_2",
        primaryJiraKey: "PRD-100-HLD-1-LLD-1",
        state: "awaiting_approval"
      },
      {
        parentWorkItemId: "wi_2",
        primaryJiraKey: "PRD-100-HLD-1-LLD-2",
        state: "awaiting_approval"
      }
    ]);
    expect(fixture.store.agentJobs.map((job) => job.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.route_downstream",
      "document.generate",
      "document.evaluate",
      "document.fan_out",
      "document.generate",
      "document.generate",
      "document.evaluate",
      "document.evaluate"
    ]);
  });

  it("can derive an optional ADR from an HLD fan-out when requested", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const hldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "hld")!;
    hldWorkItem.state = "approved";
    const fanOut = fixture.workflow.requestDocumentFanOut(hldWorkItem.primaryJiraKey, {
      requestedBy: "architect@example.com",
      includeAdr: true,
      adrTitle: "ADR: Cross-service workflow orchestration"
    });
    const duplicateFanOut = fixture.workflow.requestDocumentFanOut(hldWorkItem.primaryJiraKey, {
      includeAdr: true
    });
    await fixture.runUntilIdle();

    expect(fanOut).toEqual({ status: "accepted", jobId: "job_6" });
    expect(duplicateFanOut).toEqual({ status: "already_scheduled", jobId: "job_6" });
    expect(
      fixture.store.workItems
        .filter((workItem) => workItem.parentWorkItemId === hldWorkItem.id)
        .map((workItem) => ({
          artifactType: workItem.artifactType,
          primaryJiraKey: workItem.primaryJiraKey,
          title: workItem.title,
          state: workItem.state
        }))
    ).toEqual([
      {
        artifactType: "lld",
        primaryJiraKey: "PRD-100-HLD-1-LLD-1",
        title: "Backend LLD for PRD-100-HLD-1",
        state: "awaiting_approval"
      },
      {
        artifactType: "lld",
        primaryJiraKey: "PRD-100-HLD-1-LLD-2",
        title: "Frontend LLD for PRD-100-HLD-1",
        state: "awaiting_approval"
      },
      {
        artifactType: "adr",
        primaryJiraKey: "PRD-100-HLD-1-ADR-1",
        title: "ADR: Cross-service workflow orchestration",
        state: "awaiting_approval"
      }
    ]);
  });

  it("fans out an approved LLD into implementation Spec document jobs", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const hldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "hld")!;
    hldWorkItem.state = "approved";
    fixture.workflow.requestDocumentFanOut(hldWorkItem.primaryJiraKey);
    await fixture.runUntilIdle();

    const lldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "lld")!;
    lldWorkItem.state = "approved";
    const fanOut = fixture.workflow.requestDocumentFanOut(lldWorkItem.primaryJiraKey, {
      requestedBy: "developer@example.com"
    });
    await fixture.runUntilIdle();

    expect(fanOut).toEqual({ status: "accepted", jobId: "job_11" });
    expect(
      fixture.store.workItems
        .filter((workItem) => workItem.artifactType === "spec")
        .map((workItem) => ({
          parentWorkItemId: workItem.parentWorkItemId,
          primaryJiraKey: workItem.primaryJiraKey,
          state: workItem.state
        }))
    ).toEqual([
      {
        parentWorkItemId: lldWorkItem.id,
        primaryJiraKey: `${lldWorkItem.primaryJiraKey}-SPEC-1`,
        state: "awaiting_approval"
      },
      {
        parentWorkItemId: lldWorkItem.id,
        primaryJiraKey: `${lldWorkItem.primaryJiraKey}-SPEC-2`,
        state: "awaiting_approval"
      }
    ]);
  });

  it("starts implementation PR jobs from an approved Spec and collects review status", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const hldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "hld")!;
    hldWorkItem.state = "approved";
    fixture.workflow.requestDocumentFanOut(hldWorkItem.primaryJiraKey);
    await fixture.runUntilIdle();

    const lldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "lld")!;
    lldWorkItem.state = "approved";
    fixture.workflow.requestDocumentFanOut(lldWorkItem.primaryJiraKey);
    await fixture.runUntilIdle();

    const specWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "spec")!;
    specWorkItem.state = "approved";
    const implementation = fixture.workflow.requestImplementationStart(specWorkItem.primaryJiraKey, {
      requestedBy: "developer@example.com",
      now: new Date("2026-05-20T00:00:00.000Z")
    });
    const duplicateImplementation = fixture.workflow.requestImplementationStart(specWorkItem.primaryJiraKey);

    expect(implementation).toEqual({ status: "accepted", jobId: "job_16" });
    expect(duplicateImplementation).toEqual({ status: "already_scheduled", jobId: "job_16" });
    expect(fixture.store.agentJobs.at(-1)).toMatchObject({
      jobType: "implementation.open_pr",
      input: {
        documentType: "spec",
        documentId: `doc_${specWorkItem.id}`,
        documentVersionId: "docv_5",
        branchName: `workflow/${specWorkItem.primaryJiraKey.toLowerCase()}`,
        baseBranch: "main",
        draft: true
      }
    });

    await fixture.runUntilIdle();

    expect(specWorkItem.state).toBe("implementation_reviewed");
    expect(fixture.store.agentJobs.slice(-2).map((job) => job.jobType)).toEqual([
      "implementation.open_pr",
      "implementation.collect_pr_status"
    ]);
    expect(fixture.store.artifacts.filter((artifact) => artifact.type === "pull_request")).toMatchObject([
      {
        type: "pull_request",
        location: "external",
        url: "https://github.example.com/acme/workflow-app/pull/42",
        metadata: {
          reviewStatus: "pending",
          ciStatus: "pending"
        }
      },
      {
        type: "pull_request",
        location: "external",
        url: "https://github.example.com/acme/workflow-app/pull/42",
        metadata: {
          reviewStatus: "approved",
          ciStatus: "success"
        }
      }
    ]);

    const snapshot = createGenericPrdSnapshot(fixture.store);
    expect(snapshot.workflowJobs.slice(-2)).toMatchObject([
      {
        jobType: "implementation.open_pr",
        requiredCapabilities: ["implementation.open_pr"],
        requiredRole: "developer"
      },
      {
        jobType: "implementation.collect_pr_status",
        requiredCapabilities: ["implementation.collect_pr_status"],
        requiredRole: "developer"
      }
    ]);
    expect(snapshot.artifacts.at(-1)).toMatchObject({
      type: "pull_request",
      location: "external",
      externalId: "42",
      externalVersion: "stub-pr-head-sha",
      metadata: {
        reviewStatus: "approved",
        ciStatus: "success",
        legacyType: "pull_request"
      }
    });
  });
});
