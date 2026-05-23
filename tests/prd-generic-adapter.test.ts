import { describe, expect, it } from "vitest";
import { createEmptyStore } from "../backend/src/legacy/prd-confirmation/domain";
import { createPrdConfirmationFixture } from "../backend/src/legacy/prd-confirmation/fixture";
import { createGenericPrdSnapshot } from "../backend/src/legacy/prd-confirmation/generic-adapter";

describe("PRD generic adapter", () => {
  it("projects the existing PRD vertical slice into generic workflow and document views", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    const snapshot = createGenericPrdSnapshot(fixture.store);

    expect(snapshot.workflowRuns).toMatchObject([
      {
        id: "run_1",
        workflowDefinitionId: "prd_confirmation",
        sourceType: "jira",
        sourceKey: "PRD-100"
      }
    ]);
    expect(snapshot.policy).toMatchObject({
      approvalSource: "jira_status",
      approvalAction: "jira_transition",
      qualityFailureAction: "human_clarification",
      revisionTrigger: "explicit_request"
    });
    expect(snapshot.workflowJobs.map((job) => [job.jobType, job.requiredCapabilities])).toEqual([
      ["prd.generate_draft", ["document.generate"]],
      ["prd.evaluate_quality", ["document.evaluate"]]
    ]);
    expect(snapshot.workflowJobs.map((job) => [job.jobType, job.taskId])).toEqual([
      ["prd.generate_draft", "task_wi_1"],
      ["prd.evaluate_quality", "task_wi_1"]
    ]);
    expect(snapshot.workflowTasks).toMatchObject([
      {
        id: "task_wi_1",
        taskType: "prd",
        sourceKey: "PRD-100",
        status: "approval_pending",
        currentDocumentId: "doc_wi_1"
      }
    ]);
    expect(snapshot.documents).toMatchObject([
      {
        id: "doc_wi_1",
        workflowRunId: "run_1",
        workflowTaskId: "task_wi_1",
        type: "prd",
        sourceKey: "PRD-100",
        status: "approval_pending",
        currentVersionId: "docv_1",
        currentMarkdownArtifactId: "art_1",
        currentWikiArtifactId: "art_2"
      }
    ]);
    expect(snapshot.documentVersions).toMatchObject([
      {
        id: "docv_1",
        documentId: "doc_wi_1",
        version: 1,
        producerJobId: "job_1"
      }
    ]);
    expect(snapshot.qualityResults).toMatchObject([
      {
        id: "qgr_1",
        documentId: "doc_wi_1",
        documentVersionId: "docv_1",
        evaluatorJobId: "job_2",
        status: "passed",
        score: 91,
        summary: "PRD quality gate passed"
      }
    ]);
    expect(snapshot.artifacts.map((artifact) => [artifact.type, artifact.location])).toEqual([
      ["document_markdown", "git"],
      ["wiki_page", "wiki"]
    ]);
    expect(snapshot.artifacts.map((artifact) => artifact.documentVersionId)).toEqual(["docv_1", "docv_1"]);
  });

  it("projects routed downstream documents into the same workflow run tree", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const snapshot = createGenericPrdSnapshot(fixture.store);

    expect(snapshot.workflowRuns).toHaveLength(1);
    expect(snapshot.documents).toMatchObject([
      {
        id: "doc_wi_1",
        type: "prd",
        status: "approved"
      },
      {
        id: "doc_wi_2",
        parentDocumentId: "doc_wi_1",
        type: "hld",
        sourceKey: "PRD-100-HLD-1",
        status: "approval_pending",
        currentVersionId: "docv_2"
      }
    ]);
    expect(snapshot.workflowJobs.map((job) => [job.jobType, job.requiredCapabilities])).toEqual([
      ["prd.generate_draft", ["document.generate"]],
      ["prd.evaluate_quality", ["document.evaluate"]],
      ["prd.route_downstream", ["workflow.route"]],
      ["document.generate", ["document.generate"]],
      ["document.evaluate", ["document.evaluate"]]
    ]);
    expect(snapshot.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_wi_1",
          parentTaskId: undefined,
          taskType: "prd"
        }),
        expect.objectContaining({
          id: "task_wi_2",
          parentTaskId: "task_wi_1",
          taskType: "hld",
          currentDocumentId: "doc_wi_2"
        })
      ])
    );
  });

  it("projects HLD fan-out LLD children with parent document links", async () => {
    const fixture = createPrdConfirmationFixture();
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();

    fixture.store.workItems[0].state = "approved";
    fixture.store.externalIssues.get("PRD-100")!.status = "approved";
    fixture.workflow.requestDownstreamRouting("PRD-100");
    await fixture.runUntilIdle();

    const hldWorkItem = fixture.store.workItems.find((workItem) => workItem.artifactType === "hld");
    hldWorkItem!.state = "approved";
    fixture.workflow.requestDocumentFanOut(hldWorkItem!.primaryJiraKey);
    await fixture.runUntilIdle();

    const snapshot = createGenericPrdSnapshot(fixture.store);

    expect(snapshot.documents.filter((document) => document.type === "lld")).toMatchObject([
      {
        id: "doc_wi_3",
        parentDocumentId: "doc_wi_2",
        type: "lld",
        status: "approval_pending"
      },
      {
        id: "doc_wi_4",
        parentDocumentId: "doc_wi_2",
        type: "lld",
        status: "approval_pending"
      }
    ]);
    expect(snapshot.workflowJobs.map((job) => [job.jobType, job.requiredCapabilities])).toEqual([
      ["prd.generate_draft", ["document.generate"]],
      ["prd.evaluate_quality", ["document.evaluate"]],
      ["prd.route_downstream", ["workflow.route"]],
      ["document.generate", ["document.generate"]],
      ["document.evaluate", ["document.evaluate"]],
      ["document.fan_out", ["workflow.fanout"]],
      ["document.generate", ["document.generate"]],
      ["document.generate", ["document.generate"]],
      ["document.evaluate", ["document.evaluate"]],
      ["document.evaluate", ["document.evaluate"]]
    ]);
  });

  it("rolls up compatibility workflow runs to completed after every Code task is merged", () => {
    const store = createEmptyStore();
    store.workItems.push({
      id: "wi_spec_1",
      runId: "run_1",
      artifactType: "spec",
      primaryJiraKey: "PRD-100-SPEC-1",
      state: "implementation_merged"
    });
    store.agentJobs.push({
      id: "job_collect",
      workItemId: "wi_spec_1",
      jobType: "implementation.collect_pr_status",
      primaryJiraKey: "PRD-100-SPEC-1",
      status: "succeeded",
      input: {}
    });
    store.agentJobResults.push({
      jobId: "job_collect",
      jobType: "implementation.collect_pr_status",
      primaryJiraKey: "PRD-100-SPEC-1",
      processed: true,
      output: {
        status: "succeeded",
        merged: true
      }
    });

    const snapshot = createGenericPrdSnapshot(store);

    expect(snapshot.workflowRuns).toMatchObject([
      {
        id: "run_1",
        status: "completed"
      }
    ]);
    expect(snapshot.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_doc_wi_spec_1_code",
          taskType: "code",
          status: "completed"
        })
      ])
    );
  });
});
