import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { prdConfirmationWorkflowPolicy } from "../src/prd-confirmation/domain";
import type { JiraIssueReader, WikiFeedbackCollector } from "../src/prd-confirmation/ports";
import type {
  RecordFeedbackCommandInput,
  RecordRevisionJobCommandInput
} from "../src/workflow-api/feedback-revision-command";
import type { WorkflowApiReadModel } from "../src/workflow-api/mysql-read-model";
import type { RecordWorkflowResultProjectionInput } from "../src/workflow-api/workflow-result-command";
import { createWorkflowApiServer, type WorkflowApiServer } from "../src/workflow-api/server";
import type {
  RecordEngineTransitionCommandInput,
  RecordDocumentStateCommandInput,
  RecordWorkflowJobCommandInput
} from "../src/workflow-api/workflow-transition-command";
import type { RecordPrdIntakeInput } from "../src/workflow-api/prd-intake-command";

describe("Workflow API", () => {
  let server: WorkflowApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    server = await createWorkflowApiServer({ fixture, enableTestControls: true }).listen(0);
    baseUrl = server.url;
  });

  afterEach(async () => {
    await server.close();
  });

  it("intakes a planner-owned PRD Jira ticket and exposes workflow state", async () => {
    const intakeResponse = await postJson(`${baseUrl}/prd/intake`, {
      prdJiraKey: "PRD-100"
    });

    expect(intakeResponse.status).toBe(202);
    expect(await intakeResponse.json()).toEqual({ status: "accepted" });

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state).toMatchObject({
      prdJiraKey: "PRD-100",
      prdStatus: "drafting",
      jobs: [
        {
          type: "prd.generate_draft",
          jira: "PRD-100",
          status: "pending"
        }
      ]
    });
  });

  it("returns 404 for missing fixture-backed PRD state", async () => {
    const response = await fetch(`${baseUrl}/state/PRD-MISSING`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "PRD state not found" });
  });

  it("returns 409 when PRD intake is requested from a non-requested Jira status", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    fixture.store.externalIssues.get("PRD-100")!.status = "drafting";
    const localServer = await createWorkflowApiServer({ fixture }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "PRD Jira ticket is not ready for intake: PRD-100"
      });
    } finally {
      await localServer.close();
    }
  });

  it("returns validation errors for unreadable or incomplete PRD intake Jira data", async () => {
    const unreadableFixture = createPrdConfirmationFixture({ qualityPasses: false });
    unreadableFixture.store.externalIssues.delete("PRD-100");
    const unreadableServer = await createWorkflowApiServer({ fixture: unreadableFixture }).listen(0);

    try {
      const response = await postJson(`${unreadableServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "PRD Jira ticket is not readable: PRD-100"
      });
    } finally {
      await unreadableServer.close();
    }

    const incompleteFixture = createPrdConfirmationFixture({ qualityPasses: false });
    incompleteFixture.store.externalIssues.get("PRD-100")!.linkedSourceKeys = [];
    const incompleteServer = await createWorkflowApiServer({ fixture: incompleteFixture }).listen(0);

    try {
      const response = await postJson(`${incompleteServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "PRD Jira ticket has no linked source requests: PRD-100"
      });
    } finally {
      await incompleteServer.close();
    }

    const missingSourceFixture = createPrdConfirmationFixture({ qualityPasses: false });
    missingSourceFixture.store.externalIssues.get("PRD-100")!.linkedSourceKeys = ["OPS-MISSING"];
    const missingSourceServer = await createWorkflowApiServer({ fixture: missingSourceFixture }).listen(0);

    try {
      const response = await postJson(`${missingSourceServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Linked source request is not readable: OPS-MISSING"
      });
    } finally {
      await missingSourceServer.close();
    }
  });

  it("does not expose fixture test controls unless explicitly enabled", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const localServer = await createWorkflowApiServer({ fixture }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/test-controls/quality`, { qualityPasses: true });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
      expect(fixture.skills.qualityPasses).toBe(false);
    } finally {
      await localServer.close();
    }
  });

  it("persists fixture snapshots after state-changing API actions when a mirror is configured", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const snapshots: Array<{ runs: number; jobs: number; documents: number }> = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      snapshotMirror: {
        async persist(snapshot) {
          snapshots.push({
            runs: snapshot.workflowRuns.length,
            jobs: snapshot.workflowJobs.length,
            documents: snapshot.documents.length
          });
        }
      }
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});

      expect(snapshots).toEqual([
        { runs: 1, jobs: 1, documents: 1 },
        { runs: 1, jobs: 2, documents: 1 }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("skips fixture snapshot persistence for idle ticks", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const snapshots: unknown[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      snapshotMirror: {
        async persist(snapshot) {
          snapshots.push(snapshot);
        }
      }
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/tick`, {});

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ progressed: false });
      expect(snapshots).toEqual([]);
    } finally {
      await localServer.close();
    }
  });

  it("records PRD intake through the configured command writer", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const commandInputs: unknown[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      prdIntakeCommand: {
        async recordIntake(input) {
          commandInputs.push(input);
          return {
            runId: input.runId,
            documentId: `doc_${input.workItemId}`,
            jobId: input.jobId
          };
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(202);
      expect(commandInputs).toEqual([
        {
          runId: "run_1",
          workItemId: "wi_1",
          jobId: "job_1",
          prdJiraKey: "PRD-100",
          title: "FAQ automation PRD",
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("records feedback and revision requests through the configured command writer", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const feedbackInputs: RecordFeedbackCommandInput[] = [];
    const revisionInputs: RecordRevisionJobCommandInput[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      feedbackRevisionCommand: {
        async recordFeedback(input) {
          feedbackInputs.push(input);
        },
        async recordRevisionJob(input) {
          revisionInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/prd/feedback-revision`, {
        prdJiraKey: "PRD-100",
        requestedBy: "planner@example.com",
        feedback: "Add success metric."
      });
      await postJson(`${localServer.url}/documents/doc_wi_1/feedback`, {
        source: "app",
        author: "planner@example.com",
        body: "Clarify rollout owner."
      });
      await postJson(`${localServer.url}/documents/doc_wi_1/revisions`, {
        requestedBy: "planner@example.com",
        feedbackItemIds: ["fb_2"]
      });

      expect(feedbackInputs).toMatchObject([
        {
          feedback: {
            id: "fb_2",
            documentId: "doc_wi_1",
            body: "Clarify rollout owner."
          }
        }
      ]);
      expect(revisionInputs).toMatchObject([
        {
          runId: "run_1",
          job: {
            id: "job_2",
            jobType: "prd.apply_feedback_revision"
          },
          feedbackItems: [
            {
              id: "fb_1",
              revisionJobId: "job_2"
            }
          ],
          now: new Date("2026-05-20T00:00:00.000Z")
        },
        {
          runId: "run_1",
          job: {
            id: "job_3",
            jobType: "prd.apply_feedback_revision"
          },
          feedbackItems: [
            {
              id: "fb_2",
              revisionJobId: "job_3"
            }
          ],
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("records approval state and downstream routing through the configured command writer", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: true });
    const documentInputs: RecordDocumentStateCommandInput[] = [];
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      workflowTransitionCommand: {
        async recordDocumentState(input) {
          documentInputs.push(input);
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await tickMany(localServer.url, 2);
      await postJson(`${localServer.url}/approval-gates/gate_doc_wi_1/approve`, {
        requestedBy: "planner@example.com"
      });
      await tickMany(localServer.url, 3);
      await postJson(`${localServer.url}/approval-gates/gate_doc_wi_2/approve`, {
        requestedBy: "architect@example.com"
      });

      expect(documentInputs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({
            id: "doc_wi_1",
            status: "approved"
          }),
          now: new Date("2026-05-20T00:00:00.000Z")
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            id: "doc_wi_2",
            parentDocumentId: "doc_wi_1",
            status: "approved"
          }),
          now: new Date("2026-05-20T00:00:00.000Z")
        })
      ]));
      expect(jobInputs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run_1",
          job: expect.objectContaining({
            id: "job_3",
            jobType: "prd.route_downstream"
          }),
          now: new Date("2026-05-20T00:00:00.000Z")
        }),
        expect.objectContaining({
          runId: "run_1",
          job: expect.objectContaining({
            id: "job_6",
            jobType: "document.fan_out"
          }),
          now: new Date("2026-05-20T00:00:00.000Z")
        })
      ]));
    } finally {
      await localServer.close();
    }
  });

  it("records engine-created document states and follow-up jobs through the configured command writer", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: true });
    const documentInputs: RecordDocumentStateCommandInput[] = [];
    const engineInputs: RecordEngineTransitionCommandInput[] = [];
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      workflowTransitionCommand: {
        async recordDocumentState(input) {
          documentInputs.push(input);
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        },
        async recordEngineTransition(input) {
          engineInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/tick`, {});

      expect(documentInputs).toEqual([]);
      expect(jobInputs).toEqual([]);
      expect(engineInputs).toMatchObject([
        {
          transitionType: "prd_draft_generated",
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
                jobType: "prd.evaluate_quality",
                status: "pending"
              }
            }
          ],
          now: new Date("2026-05-20T00:00:00.000Z")
        },
        {
          transitionType: "prd_quality_passed",
          affectedWorkItemIds: ["wi_1"],
          affectedDocumentIds: ["doc_wi_1"],
          workItemState: {
            workItemId: "wi_1",
            before: "evaluating",
            after: "awaiting_approval"
          },
          externalIssueStatus: {
            issueKey: "PRD-100",
            before: "drafting",
            after: "awaiting_approval"
          },
          documents: [
            {
              id: "doc_wi_1",
              status: "approval_pending"
            }
          ],
          jobs: [],
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("records runner result projections through the configured command writer", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const projections: RecordWorkflowResultProjectionInput[] = [];
    const localServer = await createWorkflowApiServer({
      fixture,
      workflowResultCommand: {
        async recordResultProjection(input) {
          projections.push(input);
        }
      }
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/tick`, {});

      expect(projections).toHaveLength(2);
      expect(projections[0]).toMatchObject({
        jobId: "job_1",
        jobs: [
          {
            id: "job_1",
            status: "succeeded"
          },
          {
            id: "job_2",
            jobType: "prd.evaluate_quality",
            status: "pending"
          }
        ],
        jobResults: [
          {
            id: "result_1",
            jobId: "job_1"
          }
        ],
        documentVersions: [
          {
            id: "docv_1",
            producerJobId: "job_1"
          }
        ],
        artifacts: [
          {
            id: "art_1",
            producerJobId: "job_1"
          },
          {
            id: "art_2",
            producerJobId: "job_1"
          }
        ],
        qualityResults: []
      });
      expect(projections[1]).toMatchObject({
        jobId: "job_2",
        jobResults: [
          {
            id: "result_1",
            jobId: "job_1"
          },
          {
            id: "result_2",
            jobId: "job_2"
          }
        ],
        qualityResults: [
          {
            id: "qgr_1",
            evaluatorJobId: "job_2",
            status: "needs_revision"
          }
        ]
      });
    } finally {
      await localServer.close();
    }
  });

  it("uses the configured read model for generic workflow and document GET views", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return {
          run: {
            id: runId,
            workflowDefinitionId: "prd_confirmation",
            status: "active",
            sourceType: "jira",
            sourceKey: "PRD-DB",
            outputLanguage: "ko",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          jobs: [
            {
              id: "job_db_1",
              runId,
              jobType: "prd.generate_draft",
              status: "succeeded",
              input: {},
              priority: 0,
              requiredCapabilities: [],
              executionPolicy: "local_allowed",
              createdAt: "2026-05-20T00:00:00.000Z",
              updatedAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          documents: [
            {
              id: "doc_db_1",
              workflowRunId: runId,
              type: "prd",
              sourceKey: "PRD-DB",
              title: "Read model PRD",
              status: "approval_pending",
              currentVersionId: "docv_db_1",
              currentMarkdownArtifactId: "art_db_1",
              createdAt: "2026-05-20T00:00:00.000Z",
              updatedAt: "2026-05-20T00:00:00.000Z"
            }
          ]
        };
      },
      async summarizeState(sourceKey) {
        return {
          prdJiraKey: sourceKey,
          prdStatus: "approval_pending",
          policy: prdConfirmationWorkflowPolicy,
          jobs: [
            {
              id: "job_db_1",
              type: "prd.generate_draft",
              jira: "PRD-DB",
              status: "succeeded"
            }
          ],
          artifacts: [
            {
              type: "document_markdown",
              location: "git",
              url: "https://git.example.com/prd/PRD-DB.md"
            }
          ],
          latestQualityResult: null,
          latestRevisionSummary: null,
          latestResult: null
        };
      },
      async summarizeWorkflowRunTree(runId) {
        return {
          run: { id: runId },
          policy: prdConfirmationWorkflowPolicy,
          nodes: [{ id: "job_db_1", type: "workflow_job", jobType: "prd.generate_draft", status: "succeeded" }],
          documents: [{ id: "doc_db_1", workflowRunId: runId, type: "prd", sourceKey: "PRD-DB" }]
        };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            currentVersionId: "docv_db_1",
            currentMarkdownArtifactId: "art_db_1",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          workflowTask: {
            id: "task_db_1",
            runId: "run_db_1",
            taskType: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            currentDocumentId: "doc_db_1",
            metadata: {
              documentId: "doc_db_1"
            },
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: {
            id: "docv_db_1",
            documentId,
            version: 1,
            producerJobId: "job_db_1",
            summary: "Loaded from read model",
            createdAt: "2026-05-20T00:01:00.000Z"
          },
          latestQualityResult: null,
          currentArtifacts: [
            {
              id: "art_db_1",
              documentId,
              documentVersionId: "docv_db_1",
              producerJobId: "job_db_1",
              type: "document_markdown",
              location: "git",
              uri: "https://git.example.com/prd/PRD-DB.md",
              metadata: {},
              createdAt: "2026-05-20T00:01:00.000Z"
            }
          ],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return {
          documentId,
          policy: prdConfirmationWorkflowPolicy,
          versions: [{ id: "docv_db_1", documentId, version: 1, producerJobId: "job_db_1" }],
          qualityResults: [],
          artifacts: [{ id: "art_db_1", documentId, type: "document_markdown" }],
          feedbackItems: []
        };
      }
    };
    const localServer = await createWorkflowApiServer({ fixture, readModel }).listen(0);

    try {
      const run = await getJson(`${localServer.url}/workflow-runs/run_db_1`);
      const state = await getJson(`${localServer.url}/state/PRD-DB`);
      const tree = await getJson(`${localServer.url}/workflow-runs/run_db_1/tree`);
      const current = await getJson(`${localServer.url}/documents/doc_db_1/current`);
      const approvalGate = await getJson(`${localServer.url}/approval-gates/gate_doc_db_1`);
      const history = await getJson(`${localServer.url}/documents/doc_db_1/versions`);

      expect(run).toMatchObject({
        run: { id: "run_db_1", sourceKey: "PRD-DB" },
        documents: [{ id: "doc_db_1" }]
      });
      expect(tree).toMatchObject({
        nodes: [{ id: "job_db_1" }]
      });
      expect(state).toMatchObject({
        prdJiraKey: "PRD-DB",
        prdStatus: "approval_pending",
        jobs: [{ id: "job_db_1" }],
        artifacts: [{ type: "document_markdown" }]
      });
      expect(current).toMatchObject({
        document: { id: "doc_db_1", title: "Read model PRD" },
        currentVersion: { id: "docv_db_1" },
        approvalGate: { id: "gate_doc_db_1", status: "pending", externalStatus: "awaiting_approval" }
      });
      expect(approvalGate).toMatchObject({
        approvalGate: { id: "gate_doc_db_1", status: "pending", externalStatus: "awaiting_approval" }
      });
      expect(history).toMatchObject({
        documentId: "doc_db_1",
        versions: [{ id: "docv_db_1" }]
      });
    } finally {
      await localServer.close();
    }
  });

  it("serves read-model GET views without a compatibility fixture", async () => {
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          workflowTask: {
            id: "task_db_1",
            runId: "run_db_1",
            taskType: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            currentDocumentId: "doc_db_1",
            metadata: {
              documentId: "doc_db_1"
            },
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({ readModel }).listen(0);

    try {
      await expect(getJson(`${localServer.url}/state/PRD-DB`)).resolves.toMatchObject({
        prdJiraKey: "PRD-DB"
      });
      await expect(getJson(`${localServer.url}/workflow-runs/run_db_1/tree`)).resolves.toMatchObject({
        run: { id: "run_db_1" }
      });
      await expect(getJson(`${localServer.url}/documents/doc_db_1/current`)).resolves.toMatchObject({
        document: { id: "doc_db_1" },
        approvalGate: { id: "gate_doc_db_1" }
      });
      await expect(getJson(`${localServer.url}/approval-gates/gate_doc_db_1`)).resolves.toMatchObject({
        approvalGate: { id: "gate_doc_db_1" }
      });
    } finally {
      await localServer.close();
    }
  });

  it("records document feedback without a compatibility fixture when a read model and command writer are configured", async () => {
    const feedbackInputs: RecordFeedbackCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      feedbackRevisionCommand: {
        async recordFeedback(input) {
          feedbackInputs.push(input);
        },
        async recordRevisionJob() {
          throw new Error("revision command should not be called");
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/documents/doc_db_1/feedback`, {
        source: "app",
        author: "planner@example.com",
        body: " Clarify rollout owner. "
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload.feedback).toMatchObject({
        documentId: "doc_db_1",
        workItemId: "db_1",
        source: "app",
        author: "planner@example.com",
        body: "Clarify rollout owner.",
        createdAt: "2026-05-20T00:00:00.000Z"
      });
      expect(payload.feedback.id).toMatch(/^fb_/);
      expect(feedbackInputs).toEqual([{ feedback: payload.feedback }]);
    } finally {
      await localServer.close();
    }
  });

  it("records document revision jobs without a compatibility fixture when pending feedback is in the read model", async () => {
    const revisionInputs: RecordRevisionJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "needs_revision",
            currentVersionId: "docv_db_1",
            currentMarkdownArtifactId: "art_db_1",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: {
            id: "docv_db_1",
            documentId,
            version: 1,
            producerJobId: "job_generate_1",
            createdAt: "2026-05-20T00:00:00.000Z"
          },
          latestQualityResult: null,
          currentArtifacts: [
            {
              id: "art_db_1",
              documentId,
              documentVersionId: "docv_db_1",
              producerJobId: "job_generate_1",
              type: "document_markdown",
              location: "git",
              uri: "https://git.example.com/prd/PRD-DB.md",
              metadata: {},
              createdAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          pendingFeedback: [
            {
              id: "fb_db_1",
              workItemId: "db_1",
              documentId,
              source: "app",
              author: "planner@example.com",
              body: "Clarify rollout owner.",
              createdAt: "2026-05-20T00:00:00.000Z"
            }
          ]
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      feedbackRevisionCommand: {
        async recordFeedback() {
          throw new Error("feedback command should not be called");
        },
        async recordRevisionJob(input) {
          revisionInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/documents/doc_db_1/revisions`, {
        requestedBy: "planner@example.com",
        feedbackItemIds: ["fb_db_1"]
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        status: "accepted",
        revisionJob: {
          jobType: "prd.apply_feedback_revision",
          status: "pending"
        },
        feedbackItemIds: ["fb_db_1"]
      });
      expect(payload.revisionJob.id).toMatch(/^job_/);
      expect(revisionInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_db_1",
          job: {
            id: payload.revisionJob.id,
            workItemId: "db_1",
            jobType: "prd.apply_feedback_revision",
            primaryJiraKey: "PRD-DB",
            status: "pending",
            input: {
              requestedBy: "planner@example.com",
              documentType: "prd",
              feedback: "- [app by planner@example.com] Clarify rollout owner.",
              feedbackItemIds: ["fb_db_1"],
              sourceDocumentId: "doc_db_1",
              currentDocumentVersionId: "docv_db_1",
              currentDocumentVersionProducerJobId: "job_generate_1",
              currentDocumentArtifactUrl: "https://git.example.com/prd/PRD-DB.md"
            }
          },
          feedbackItems: [
            {
              id: "fb_db_1",
              revisionJobId: payload.revisionJob.id
            }
          ],
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("records PRD feedback revision without a compatibility fixture", async () => {
    const revisionInputs: RecordRevisionJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { documentId: "doc_db_1", prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "needs_revision",
            currentVersionId: "docv_db_1",
            currentMarkdownArtifactId: "art_db_1",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: {
            id: "docv_db_1",
            documentId,
            version: 1,
            producerJobId: "job_generate_1",
            createdAt: "2026-05-20T00:00:00.000Z"
          },
          latestQualityResult: null,
          currentArtifacts: [
            {
              id: "art_db_1",
              documentId,
              documentVersionId: "docv_db_1",
              producerJobId: "job_generate_1",
              type: "document_markdown",
              location: "git",
              uri: "https://git.example.com/prd/PRD-DB.md",
              metadata: {},
              createdAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      feedbackRevisionCommand: {
        async recordFeedback() {
          throw new Error("feedback command should not be called");
        },
        async recordRevisionJob(input) {
          revisionInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/prd/feedback-revision`, {
        prdJiraKey: "PRD-DB",
        requestedBy: "planner@example.com",
        feedback: " Add success metric. "
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        status: "accepted",
        feedbackItemIds: [expect.stringMatching(/^fb_/)]
      });
      expect(payload.jobId).toMatch(/^job_/);
      expect(revisionInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_db_1",
          job: {
            id: payload.jobId,
            workItemId: "db_1",
            jobType: "prd.apply_feedback_revision",
            primaryJiraKey: "PRD-DB",
            status: "pending",
            input: {
              requestedBy: "planner@example.com",
              documentType: "prd",
              feedback: "- [app by planner@example.com] Add success metric.",
              feedbackItemIds: [payload.feedbackItemIds[0]],
              sourceDocumentId: "doc_db_1",
              currentDocumentVersionId: "docv_db_1",
              currentDocumentVersionProducerJobId: "job_generate_1",
              currentDocumentArtifactUrl: "https://git.example.com/prd/PRD-DB.md"
            }
          },
          feedbackItems: [
            {
              id: payload.feedbackItemIds[0],
              revisionJobId: payload.jobId,
              documentId: "doc_db_1",
              workItemId: "db_1",
              source: "app",
              author: "planner@example.com",
              body: "Add success metric."
            }
          ],
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("imports wiki feedback without a compatibility fixture when a read model and collector are configured", async () => {
    const feedbackInputs: RecordFeedbackCommandInput[] = [];
    const wikiFeedbackCollector: WikiFeedbackCollector = {
      async collectPageFeedback(input) {
        expect(input).toMatchObject({
          pageUrl: "https://wiki.example.com/pages/PRD-DB",
          limit: 10
        });

        return {
          pageId: "999",
          comments: [
            {
              externalId: "confluence-comment:c-1",
              author: "reviewer@example.com",
              body: "Add launch KPI.",
              createdAt: "2026-05-20T01:00:00.000Z",
              url: "https://wiki.example.com/comment/c-1",
              metadata: {
                inline: true
              }
            }
          ]
        };
      }
    };
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            currentWikiArtifactId: "art_wiki_1",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [
            {
              id: "art_wiki_1",
              documentId,
              producerJobId: "job_generate_1",
              type: "wiki_page",
              location: "wiki",
              uri: "https://wiki.example.com/pages/PRD-DB",
              metadata: {},
              createdAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      wikiFeedbackCollector,
      feedbackRevisionCommand: {
        async recordFeedback(input) {
          feedbackInputs.push(input);
        },
        async recordRevisionJob() {
          throw new Error("revision command should not be called");
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/documents/doc_db_1/wiki-feedback`, {
        limit: 10
      });
      const payload = await response.json();

      expect(response.status).toBe(201);
      expect(payload).toMatchObject({
        pageId: "999",
        importedCount: 1,
        duplicateCount: 0,
        feedbackItems: [
          {
            documentId: "doc_db_1",
            workItemId: "db_1",
            source: "wiki",
            author: "reviewer@example.com",
            body: "Add launch KPI.",
            externalId: "confluence-comment:c-1",
            externalUrl: "https://wiki.example.com/comment/c-1",
            createdAt: "2026-05-20T01:00:00.000Z",
            metadata: {
              inline: true,
              confluencePageId: "999"
            }
          }
        ]
      });
      expect(payload.feedbackItems[0].id).toMatch(/^fb_/);
      expect(feedbackInputs).toEqual([{ feedback: payload.feedbackItems[0] }]);
    } finally {
      await localServer.close();
    }
  });

  it("approves a read-model approval gate without a compatibility fixture and records downstream routing", async () => {
    const documentInputs: RecordDocumentStateCommandInput[] = [];
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          workflowTask: {
            id: "task_db_1",
            runId: "run_db_1",
            taskType: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            currentDocumentId: "doc_db_1",
            metadata: {
              documentId: "doc_db_1"
            },
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState(input) {
          documentInputs.push(input);
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/approval-gates/gate_doc_db_1/approve`, {
        requestedBy: "planner@example.com",
        reason: "Looks good"
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        approvalGate: {
          id: "gate_doc_db_1",
          status: "approved",
          externalStatus: "approved",
          lastAction: {
            type: "jira_transition",
            sourceOfTruth: "jira_status",
            actor: "planner@example.com",
            reason: "Looks good",
            fromExternalStatus: "awaiting_approval",
            toExternalStatus: "approved"
          }
        },
        routingJob: {
          jobType: "prd.route_downstream",
          status: "pending"
        },
        routingStatus: "accepted"
      });
      expect(payload.routingJob.id).toMatch(/^job_/);
      expect(documentInputs).toMatchObject([
        {
          document: {
            id: "doc_db_1",
            status: "approved",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          workflowTask: {
            id: "task_db_1",
            status: "approval_pending"
          },
          actor: "planner@example.com",
          reason: "Looks good",
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
      expect(jobInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_db_1",
          job: {
            id: payload.routingJob.id,
            workItemId: "db_1",
            jobType: "prd.route_downstream",
            primaryJiraKey: "PRD-DB",
            status: "pending",
            input: {
              requestedBy: "planner@example.com",
              approvedAt: "2026-05-20T00:00:00.000Z",
              sourceDocumentId: "doc_db_1"
            }
          },
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("does not duplicate read-model downstream jobs on repeated approval", async () => {
    const documentInputs: RecordDocumentStateCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return {
          run: { id: runId, sourceKey: "PRD-DB" },
          jobs: [
            {
              id: "job_existing_route",
              runId,
              taskId: "task_db_1",
              jobType: "prd.route_downstream",
              status: "pending",
              input: {
                sourceDocumentId: "doc_db_1"
              },
              priority: 0,
              projectId: "prd-confirmation",
              repositoryId: "prd-docs",
              requiredCapabilities: ["document.generate"],
              executionPolicy: "local_allowed",
              createdAt: "2026-05-20T00:00:00.000Z",
              updatedAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          documents: []
        };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState(input) {
          documentInputs.push(input);
        },
        async recordWorkflowJob() {
          throw new Error("duplicate downstream job should not be recorded");
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/approval-gates/gate_doc_db_1/approve`, {
        requestedBy: "planner@example.com"
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        routingStatus: "already_scheduled",
        routingJob: {
          id: "job_existing_route",
          jobType: "prd.route_downstream",
          input: {
            sourceDocumentId: "doc_db_1"
          }
        }
      });
      expect(documentInputs).toHaveLength(1);
    } finally {
      await localServer.close();
    }
  });

  it("refreshes an approved read-model gate and schedules downstream work without a fixture", async () => {
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "PRD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approved",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("document command should not be called");
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/approval-gates/gate_doc_db_1/refresh`, {});
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        approvalGate: {
          id: "gate_doc_db_1",
          status: "approved",
          externalStatus: "approved"
        },
        routingStatus: "accepted",
        routingJob: {
          jobType: "prd.route_downstream",
          status: "pending",
          input: {
            sourceDocumentId: "doc_db_1",
            approvedAt: "2026-05-20T00:00:00.000Z"
          }
        }
      });
      expect(payload.routingJob.id).toMatch(/^job_/);
      expect(jobInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_db_1",
          job: {
            id: payload.routingJob.id,
            jobType: "prd.route_downstream",
            primaryJiraKey: "PRD-DB"
          },
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("does not duplicate downstream work when an approved read-model gate refreshes again", async () => {
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return {
          run: { id: runId, sourceKey: "PRD-DB" },
          jobs: [
            {
              id: "job_existing_route",
              runId,
              taskId: "task_db_1",
              jobType: "prd.route_downstream",
              status: "pending",
              input: {
                sourceDocumentId: "doc_db_1"
              },
              priority: 0,
              projectId: "prd-confirmation",
              repositoryId: "prd-docs",
              requiredCapabilities: ["document.generate"],
              executionPolicy: "local_allowed",
              createdAt: "2026-05-20T00:00:00.000Z",
              updatedAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          documents: []
        };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_db_1",
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approved",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("document command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("duplicate downstream job should not be recorded");
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/approval-gates/gate_doc_db_1/refresh`, {});
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        routingStatus: "already_scheduled",
        routingJob: {
          id: "job_existing_route",
          jobType: "prd.route_downstream"
        }
      });
    } finally {
      await localServer.close();
    }
  });

  it("refreshes an approved Spec gate and schedules implementation work without a fixture", async () => {
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "SPEC-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_spec_1",
            type: "spec",
            sourceKey: "SPEC-DB",
            title: "Read model Spec",
            status: "approved",
            currentVersionId: "docv_spec_1",
            currentMarkdownArtifactId: "art_spec_1",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: {
            id: "docv_spec_1",
            documentId,
            version: 1,
            producerJobId: "job_spec_generate",
            createdAt: "2026-05-20T00:00:00.000Z"
          },
          latestQualityResult: null,
          currentArtifacts: [
            {
              id: "art_spec_1",
              documentId,
              documentVersionId: "docv_spec_1",
              producerJobId: "job_spec_generate",
              type: "document_markdown",
              location: "git",
              uri: "https://git.example.com/spec/SPEC-DB.md",
              metadata: {},
              createdAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("document command should not be called");
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/approval-gates/gate_doc_spec_1/refresh`, {});
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        approvalGate: {
          id: "gate_doc_spec_1",
          status: "approved"
        },
        routingStatus: "accepted",
        routingTask: {
          id: "task_doc_spec_1_code",
          parentTaskId: "task_spec_1",
          taskType: "code",
          currentDocumentId: "doc_spec_1"
        },
        routingJob: {
          jobType: "implementation.open_pr",
          status: "pending",
          input: {
            documentType: "spec",
            documentId: "doc_spec_1",
            documentVersionId: "docv_spec_1",
            sourceDocumentId: "doc_spec_1",
            currentDocumentArtifactUrl: "https://git.example.com/spec/SPEC-DB.md",
            runnerSkill: {
              id: "implementation.pr-author",
              version: "0.1.0"
            }
          }
        }
      });
      expect(jobInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_doc_spec_1_code",
          workflowTask: {
            id: "task_doc_spec_1_code",
            parentTaskId: "task_spec_1"
          },
          job: {
            id: payload.routingJob.id,
            jobType: "implementation.open_pr",
            primaryJiraKey: "SPEC-DB"
          },
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("requests document fan-out without a compatibility fixture", async () => {
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return { run: { id: runId, sourceKey: "HLD-DB" }, jobs: [], documents: [] };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_hld_1",
            type: "hld",
            sourceKey: "HLD-DB",
            title: "Read model HLD",
            status: "approved",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("document command should not be called");
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/documents/doc_hld_1/fan-out`, {
        requestedBy: "architect@example.com",
        includeAdr: true,
        adrTitle: "ADR: Local runner orchestration"
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        status: "accepted",
        fanOutStatus: "accepted",
        fanOutJob: {
          jobType: "document.fan_out",
          status: "pending",
          input: {
            requestedBy: "architect@example.com",
            approvedAt: "2026-05-20T00:00:00.000Z",
            sourceDocumentId: "doc_hld_1",
            parentDocumentType: "hld",
            targetDocumentType: "lld",
            includeAdr: true,
            adrTitle: "ADR: Local runner orchestration",
            adrOnly: false
          }
        }
      });
      expect(payload.fanOutJob.id).toMatch(/^job_/);
      expect(jobInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_hld_1",
          job: {
            id: payload.fanOutJob.id,
            workItemId: "hld_1",
            jobType: "document.fan_out",
            primaryJiraKey: "HLD-DB",
            status: "pending"
          },
          now: new Date("2026-05-20T00:00:00.000Z")
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("schedules ADR-only fan-out without a fixture when standard fan-out already exists", async () => {
    const jobInputs: RecordWorkflowJobCommandInput[] = [];
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun(runId) {
        return {
          run: { id: runId, sourceKey: "HLD-DB" },
          jobs: [
            {
              id: "job_standard_fanout",
              runId,
              taskId: "task_hld_1",
              jobType: "document.fan_out",
              status: "succeeded",
              input: {
                sourceDocumentId: "doc_hld_1",
                includeAdr: false,
                adrOnly: false
              },
              priority: 0,
              projectId: "prd-confirmation",
              repositoryId: "prd-docs",
              requiredCapabilities: ["document.generate"],
              executionPolicy: "local_allowed",
              createdAt: "2026-05-20T00:00:00.000Z",
              updatedAt: "2026-05-20T00:00:00.000Z"
            }
          ],
          documents: []
        };
      },
      async summarizeState(sourceKey) {
        return { prdJiraKey: sourceKey, jobs: [], artifacts: [] };
      },
      async summarizeWorkflowRunTree(runId) {
        return { run: { id: runId }, nodes: [], documents: [] };
      },
      async summarizeDocumentCurrent(documentId) {
        return {
          document: {
            id: documentId,
            workflowRunId: "run_db_1",
            workflowTaskId: "task_hld_1",
            type: "hld",
            sourceKey: "HLD-DB",
            title: "Read model HLD",
            status: "approved",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          },
          policy: prdConfirmationWorkflowPolicy,
          currentVersion: null,
          latestQualityResult: null,
          currentArtifacts: [],
          pendingFeedback: []
        };
      },
      async summarizeDocumentHistory(documentId) {
        return { documentId, versions: [], qualityResults: [], artifacts: [], feedbackItems: [] };
      }
    };
    const localServer = await createWorkflowApiServer({
      readModel,
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("document command should not be called");
        },
        async recordWorkflowJob(input) {
          jobInputs.push(input);
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/documents/doc_hld_1/fan-out`, {
        requestedBy: "architect@example.com",
        includeAdr: true,
        adrTitle: "ADR: Local runner orchestration"
      });
      const payload = await response.json();

      expect(response.status).toBe(202);
      expect(payload).toMatchObject({
        status: "accepted",
        fanOutStatus: "accepted",
        fanOutJob: {
          jobType: "document.fan_out",
          input: {
            sourceDocumentId: "doc_hld_1",
            includeAdr: true,
            adrTitle: "ADR: Local runner orchestration",
            adrOnly: true
          }
        }
      });
      expect(jobInputs).toMatchObject([
        {
          runId: "run_db_1",
          taskId: "task_hld_1",
          job: {
            id: payload.fanOutJob.id,
            jobType: "document.fan_out",
            input: {
              includeAdr: true,
              adrOnly: true
            }
          }
        }
      ]);
    } finally {
      await localServer.close();
    }
  });

  it("intakes PRD Jira tickets without a compatibility fixture when a Jira reader and command writer are configured", async () => {
    const commandInputs: RecordPrdIntakeInput[] = [];
    const jiraIssueReader: JiraIssueReader = {
      async loadPrdWithSources(prdJiraKey) {
        expect(prdJiraKey).toBe("PRD-DB");

        return {
          prd: {
            key: "PRD-DB",
            issueType: "prd",
            status: "prd_requested",
            summary: "Read model PRD",
            linkedSourceKeys: ["OPS-1"]
          },
          sources: [
            {
              key: "OPS-1",
              issueType: "operational_request",
              status: "open",
              summary: "Source request"
            }
          ]
        };
      }
    };
    const localServer = await createWorkflowApiServer({
      jiraIssueReader,
      prdIntakeCommand: {
        async recordIntake(input) {
          commandInputs.push(input);

          return {
            runId: input.runId,
            documentId: `doc_${input.workItemId}`,
            jobId: input.jobId
          };
        }
      },
      now: () => new Date("2026-05-20T00:00:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${localServer.url}/prd/intake`, {
        prdJiraKey: "PRD-DB",
        requestedBy: "planner@example.com"
      });

      expect(response.status).toBe(202);
      const payload = await response.json();
      expect(payload).toMatchObject({
        status: "accepted",
        documentId: expect.stringMatching(/^doc_wi_/),
        jobId: expect.stringMatching(/^job_/),
        runId: expect.stringMatching(/^run_/)
      });
      expect(commandInputs).toHaveLength(1);
      expect(commandInputs[0]).toMatchObject({
        prdJiraKey: "PRD-DB",
        title: "Read model PRD",
        requestedBy: "planner@example.com",
        now: new Date("2026-05-20T00:00:00.000Z")
      });
      expect(commandInputs[0].runId).toMatch(/^run_/);
      expect(commandInputs[0].workItemId).toMatch(/^wi_/);
      expect(commandInputs[0].jobId).toMatch(/^job_/);
    } finally {
      await localServer.close();
    }
  });

  it("fails compatibility transition routes closed when no fixture is configured", async () => {
    const localServer = await createWorkflowApiServer({}).listen(0);

    try {
      const response = await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: "Compatibility fixture workflow is not configured"
      });
    } finally {
      await localServer.close();
    }
  });

  it("does not fall back to fixture state when the configured read model has no PRD state", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: true });
    await fixture.workflow.intakePrdTicket("PRD-100");
    const readModel: WorkflowApiReadModel = {
      async summarizeWorkflowRun() {
        return undefined;
      },
      async summarizeState() {
        return undefined;
      },
      async summarizeWorkflowRunTree() {
        return undefined;
      },
      async summarizeDocumentCurrent() {
        return undefined;
      },
      async summarizeDocumentHistory() {
        return undefined;
      }
    };
    const localServer = await createWorkflowApiServer({ fixture, readModel }).listen(0);

    try {
      const response = await fetch(`${localServer.url}/state/PRD-100`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "PRD state not found" });
    } finally {
      await localServer.close();
    }
  });

  it("runs scheduler, runner, and engine ticks through HTTP", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });

    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state.prdStatus).toBe("needs_revision");
    expect(state.policy).toMatchObject({
      approvalSource: "jira_status",
      approvalAction: "jira_transition",
      qualityFailureAction: "human_clarification",
      revisionTrigger: "explicit_request",
      downstreamStart: "after_jira_approved_status"
    });
    expect(state.jobs.map((job: { type: string }) => job.type)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality"
    ]);
    expect(state.latestResult).toMatchObject({
      status: "needs_revision",
      missingInformation: ["Success metric is missing"]
    });
    expect(state.latestQualityResult).toMatchObject({
      documentVersionId: "docv_1",
      evaluatorJobId: "job_2",
      status: "needs_revision",
      score: 72,
      qualityFailureAction: "human_clarification",
      autoRevisionScheduled: false
    });
  });

  it("advances compatibility workflows through the internal tick loop when configured", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const localServer = await createWorkflowApiServer({
      fixture,
      internalTickIntervalMs: 5
    }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });

      const state = await waitFor(
        () => getJson(`${localServer.url}/state/PRD-100`),
        (candidate) => candidate.prdStatus === "needs_revision"
      );

      expect(state.jobs.map((job: { type: string }) => job.type)).toEqual([
        "prd.generate_draft",
        "prd.evaluate_quality"
      ]);
      expect(state.latestQualityResult).toMatchObject({
        evaluatorJobId: "job_2",
        status: "needs_revision"
      });
    } finally {
      await localServer.close();
    }
  });

  it("accepts explicit feedback revision and reaches approval-ready state", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const feedbackResponse = await postJson(`${baseUrl}/prd/feedback-revision`, {
      prdJiraKey: "PRD-100",
      requestedBy: "planner@example.com",
      feedback: "Add success metric: reduce repeated FAQ handling time by 30%."
    });

    expect(feedbackResponse.status).toBe(202);

    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state).toMatchObject({
      prdStatus: "awaiting_approval",
      latestRevisionSummary: "Add success metric: reduce repeated FAQ handling time by 30%."
    });
    expect(state.jobs.map((job: { type: string }) => job.type)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.apply_feedback_revision",
      "prd.evaluate_quality"
    ]);
  });

  it("separates generic feedback storage, revision request, and approval actions", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const feedbackResponse = await postJson(`${baseUrl}/documents/doc_wi_1/feedback`, {
      source: "app",
      author: "planner@example.com",
      body: "Add success metric: reduce repeated FAQ handling time by 30%."
    });
    const stateBeforeRevision = await getJson(`${baseUrl}/state/PRD-100`);
    const revisionResponse = await postJson(`${baseUrl}/documents/doc_wi_1/revisions`, {
      requestedBy: "planner@example.com"
    });

    expect(feedbackResponse.status).toBe(201);
    expect(await feedbackResponse.json()).toMatchObject({
      feedback: {
        id: "fb_1",
        documentId: "doc_wi_1",
        source: "app"
      }
    });
    expect(stateBeforeRevision.jobs.map((job: { type: string }) => job.type)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality"
    ]);
    expect(revisionResponse.status).toBe(202);
    expect(await revisionResponse.json()).toMatchObject({
      revisionJob: {
        id: "job_3",
        jobType: "prd.apply_feedback_revision",
        input: {
          feedbackItemIds: ["fb_1"],
          sourceDocumentId: "doc_wi_1",
          currentDocumentVersionId: "docv_1",
          currentDocumentVersionProducerJobId: "job_1"
        }
      },
      feedbackItemIds: ["fb_1"]
    });

    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const current = await getJson(`${baseUrl}/documents/doc_wi_1/current`);
    const approval = await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });
    const approvedCurrent = await getJson(`${baseUrl}/documents/doc_wi_1/current`);

    expect(current).toMatchObject({
      document: {
        status: "approval_pending"
      },
      approvalGate: {
        id: "gate_doc_wi_1",
        status: "pending",
        sourceOfTruth: "jira_status",
        action: "jira_transition",
        approvalRole: "planner",
        downstreamStart: "after_jira_approved_status",
        externalIssueKey: "PRD-100",
        transition: {
          pendingStatus: "awaiting_approval",
          approvedStatus: "approved"
        }
      },
      pendingFeedback: []
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      approvalGate: {
        id: "gate_doc_wi_1",
        status: "approved",
        externalStatus: "approved",
        lastAction: {
          type: "jira_transition",
          sourceOfTruth: "jira_status",
          fromExternalStatus: "awaiting_approval",
          toExternalStatus: "approved"
        }
      },
      routingJob: {
        id: "job_5",
        jobType: "prd.route_downstream",
        status: "pending"
      }
    });
    expect(approvedCurrent).toMatchObject({
      document: {
        status: "approved"
      },
      approvalGate: {
        status: "approved"
      }
    });
  });

  it("imports explicit Confluence wiki feedback into document revision feedback", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const wikiFeedbackCollector: WikiFeedbackCollector = {
      async collectPageFeedback(input) {
        expect(input).toMatchObject({
          pageId: "999",
          limit: 20
        });

        return {
          pageId: "999",
          comments: [
            {
              externalId: "confluence-comment:c-1",
              author: "planner@example.com",
              body: "Add rollout KPI before approval.",
              createdAt: "2026-05-20T08:00:00.000Z",
              url: "https://wiki.example.com/wiki/spaces/PRD/pages/999?focusedCommentId=c-1",
              metadata: {
                resolutionStatus: "open"
              }
            }
          ]
        };
      }
    };
    const localServer = await createWorkflowApiServer({ fixture, wikiFeedbackCollector }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});

      const feedbackImport = await postJson(`${localServer.url}/documents/doc_wi_1/wiki-feedback`, {
        pageId: "999",
        limit: 20
      });
      const duplicateImport = await postJson(`${localServer.url}/documents/doc_wi_1/wiki-feedback`, {
        pageId: "999",
        limit: 20
      });
      const revision = await postJson(`${localServer.url}/documents/doc_wi_1/revisions`, {
        requestedBy: "planner@example.com"
      });

      expect(feedbackImport.status).toBe(201);
      expect(await feedbackImport.json()).toMatchObject({
        pageId: "999",
        importedCount: 1,
        duplicateCount: 0,
        feedbackItems: [
          {
            id: "fb_1",
            source: "wiki",
            author: "planner@example.com",
            body: "Add rollout KPI before approval.",
            externalId: "confluence-comment:c-1",
            externalUrl: "https://wiki.example.com/wiki/spaces/PRD/pages/999?focusedCommentId=c-1"
          }
        ]
      });
      expect(await duplicateImport.json()).toMatchObject({
        importedCount: 0,
        duplicateCount: 1,
        feedbackItems: [
          {
            id: "fb_1"
          }
        ]
      });
      expect(revision.status).toBe(202);
      expect(await revision.json()).toMatchObject({
        revisionJob: {
          jobType: "prd.apply_feedback_revision",
          input: {
            feedbackItemIds: ["fb_1"],
            feedback: "- [wiki by planner@example.com] Add rollout KPI before approval."
          }
        }
      });
    } finally {
      await localServer.close();
    }
  });

  it("starts downstream routing from PRD approval and exposes the routed HLD in the run tree", async () => {
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const approval = await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });

    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      routingJob: {
        id: "job_3",
        jobType: "prd.route_downstream",
        requiredCapabilities: ["workflow.route"]
      }
    });

    await postJson(`${baseUrl}/tick`, {});

    const tree = await getJson(`${baseUrl}/workflow-runs/run_1/tree`);

    expect(tree.policy).toMatchObject({
      approvalSource: "jira_status",
      downstreamStart: "after_jira_approved_status"
    });
    expect(tree.documents).toMatchObject([
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
        status: "draft"
      }
    ]);
    const taskNodes = tree.nodes.filter((node: { type: string }) => node.type === "workflow_task");
    expect(taskNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_wi_1",
          type: "workflow_task"
        }),
        expect.objectContaining({
          id: "task_wi_2",
          parentTaskId: "task_wi_1",
          type: "workflow_task"
        })
      ])
    );
    const jobNodes = tree.nodes.filter((node: { type: string }) => node.type === "workflow_job");
    expect(jobNodes.map((node: { jobType: string }) => node.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.route_downstream",
      "document.generate"
    ]);
    expect(jobNodes.at(-1)).toMatchObject({
      jobType: "document.generate",
      primaryDocumentId: "doc_wi_2"
    });
    expect(tree.edges).toEqual(
      expect.arrayContaining([
        {
          id: "edge_task_wi_1_task_wi_2",
          type: "workflow_task_parent",
          from: "task_wi_1",
          to: "task_wi_2"
        },
        {
          id: "edge_task_wi_2_job_4",
          type: "workflow_task_job",
          from: "task_wi_2",
          to: "job_4"
        }
      ])
    );
  });

  it("creates generic document revision jobs from the latest downstream document version", async () => {
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    await postJson(`${baseUrl}/documents/doc_wi_2/feedback`, {
      source: "jira",
      author: "architect@example.com",
      body: "Clarify service ownership before LLD fan-out."
    });
    const revision = await postJson(`${baseUrl}/documents/doc_wi_2/revisions`, {
      requestedBy: "architect@example.com"
    });

    expect(revision.status).toBe(202);
    expect(await revision.json()).toMatchObject({
      revisionJob: {
        id: "job_6",
        jobType: "document.revise",
        input: {
          documentType: "hld",
          feedbackItemIds: ["fb_1"],
          sourceDocumentId: "doc_wi_2",
          currentDocumentVersionId: "docv_2",
          currentDocumentVersionProducerJobId: "job_4"
        }
      }
    });

    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const history = await getJson(`${baseUrl}/documents/doc_wi_2/versions`);

    expect(history).toMatchObject({
      versions: [
        {
          id: "docv_2",
          producerJobId: "job_4"
        },
        {
          id: "docv_3",
          producerJobId: "job_6",
          revisionJobId: "job_6",
          revisionSummary: "- [jira by architect@example.com] Clarify service ownership before LLD fan-out."
        }
      ],
      qualityResults: [
        {
          documentVersionId: "docv_2",
          evaluatorJobId: "job_5",
          status: "passed"
        },
        {
          documentVersionId: "docv_3",
          evaluatorJobId: "job_7",
          status: "passed"
        }
      ]
    });
  });

  it("starts HLD fan-out from HLD approval and exposes LLD child documents", async () => {
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const hldApproval = await postJson(`${baseUrl}/approval-gates/gate_doc_wi_2/approve`, {
      requestedBy: "architect@example.com"
    });

    expect(hldApproval.status).toBe(200);
    expect(await hldApproval.json()).toMatchObject({
      approvalGate: {
        id: "gate_doc_wi_2",
        status: "approved"
      },
      routingJob: {
        id: "job_6",
        jobType: "document.fan_out",
        requiredCapabilities: ["workflow.fanout"]
      }
    });

    await postJson(`${baseUrl}/tick`, {});

    const tree = await getJson(`${baseUrl}/workflow-runs/run_1/tree`);

    expect(tree.documents.filter((document: { type: string }) => document.type === "lld")).toMatchObject([
      {
        id: "doc_wi_3",
        parentDocumentId: "doc_wi_2",
        sourceKey: "PRD-100-HLD-1-LLD-1",
        status: "draft"
      },
      {
        id: "doc_wi_4",
        parentDocumentId: "doc_wi_2",
        sourceKey: "PRD-100-HLD-1-LLD-2",
        status: "draft"
      }
    ]);
    const jobNodes = tree.nodes.filter((node: { type: string }) => node.type === "workflow_job");
    expect(jobNodes.map((node: { jobType: string }) => node.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.route_downstream",
      "document.generate",
      "document.evaluate",
      "document.fan_out",
      "document.generate",
      "document.generate"
    ]);
  });

  it("can request an optional ADR fan-out for an approved HLD document", async () => {
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_2/approve`, {
      requestedBy: "architect@example.com"
    });
    await postJson(`${baseUrl}/tick`, {});

    const adrFanOut = await postJson(`${baseUrl}/documents/doc_wi_2/fan-out`, {
      requestedBy: "architect@example.com",
      includeAdr: true,
      adrTitle: "ADR: Local runner orchestration"
    });

    expect(adrFanOut.status).toBe(202);
    expect(await adrFanOut.json()).toMatchObject({
      status: "accepted",
      fanOutStatus: "accepted",
      fanOutJob: {
        id: "job_9",
        jobType: "document.fan_out",
        input: {
          includeAdr: true,
          adrOnly: true,
          adrTitle: "ADR: Local runner orchestration"
        }
      }
    });

    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const tree = await getJson(`${baseUrl}/workflow-runs/run_1/tree`);

    expect(tree.documents.filter((document: { type: string }) => document.type === "adr")).toMatchObject([
      {
        id: "doc_wi_5",
        parentDocumentId: "doc_wi_2",
        sourceKey: "PRD-100-HLD-1-ADR-1",
        title: "ADR: Local runner orchestration",
        status: "draft"
      }
    ]);
  });

  it("starts implementation PR jobs when an approved Spec passes its gate", async () => {
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await tickMany(baseUrl, 2);
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_1/approve`, {
      requestedBy: "planner@example.com"
    });
    await tickMany(baseUrl, 3);
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_2/approve`, {
      requestedBy: "architect@example.com"
    });
    await tickMany(baseUrl, 5);
    await postJson(`${baseUrl}/approval-gates/gate_doc_wi_3/approve`, {
      requestedBy: "developer@example.com"
    });
    await tickMany(baseUrl, 5);

    const specApproval = await postJson(`${baseUrl}/approval-gates/gate_doc_wi_5/approve`, {
      requestedBy: "developer@example.com"
    });

    expect(specApproval.status).toBe(200);
    expect(await specApproval.json()).toMatchObject({
      approvalGate: {
        id: "gate_doc_wi_5",
        status: "approved",
        approvalRole: "developer"
      },
      routingJob: {
        id: "job_16",
        jobType: "implementation.open_pr",
        requiredCapabilities: ["implementation.open_pr"],
        input: {
          documentType: "spec",
          documentId: "doc_wi_5",
          documentVersionId: "docv_5",
          branchName: "workflow/prd-100-hld-1-lld-1-spec-1",
          baseBranch: "main",
          runnerSkill: {
            id: "implementation.pr-author",
            version: "0.1.0"
          },
          draft: true
        }
      },
      routingStatus: "accepted"
    });

    await tickMany(baseUrl, 2);

    const tree = await getJson(`${baseUrl}/workflow-runs/run_1/tree`);
    const history = await getJson(`${baseUrl}/documents/doc_wi_5/versions`);

    expect((tree.nodes as Array<{ jobType: string }>).slice(-2).map((node) => node.jobType)).toEqual([
      "implementation.open_pr",
      "implementation.collect_pr_status"
    ]);
    expect(history).toMatchObject({
      artifacts: [
        expect.objectContaining({
          type: "document_markdown"
        }),
        expect.objectContaining({
          type: "wiki_page"
        }),
        expect.objectContaining({
          type: "pull_request",
          location: "external",
          metadata: expect.objectContaining({
            reviewStatus: "pending",
            ciStatus: "pending"
          })
        }),
        expect.objectContaining({
          type: "pull_request",
          location: "external",
          metadata: expect.objectContaining({
            reviewStatus: "approved",
            ciStatus: "success"
          })
        })
      ]
    });
  });

  it("shows only the latest artifact for each artifact type and location", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/prd/feedback-revision`, {
      prdJiraKey: "PRD-100",
      requestedBy: "planner@example.com",
      feedback: "Add success metric."
    });
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state.artifacts).toEqual([
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

  it("keeps artifact history internally with creation timestamps", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const localServer = await createWorkflowApiServer({ fixture }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/prd/feedback-revision`, {
        prdJiraKey: "PRD-100",
        requestedBy: "planner@example.com",
        feedback: "Add success metric."
      });
      await postJson(`${localServer.url}/tick`, {});

      expect(fixture.store.artifacts).toHaveLength(4);
      expect(fixture.store.artifacts.every((artifact) => artifact.createdAt)).toBe(true);
    } finally {
      await localServer.close();
    }
  });

  it("exposes generic workflow run and tree views", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});

    const run = await getJson(`${baseUrl}/workflow-runs/run_1`);
    const tree = await getJson(`${baseUrl}/workflow-runs/run_1/tree`);

    expect(run).toMatchObject({
      run: {
        id: "run_1",
        workflowDefinitionId: "prd_confirmation",
        sourceKey: "PRD-100"
      },
      jobs: [
        {
          id: "job_1",
          jobType: "prd.generate_draft",
          status: "succeeded"
        },
        {
          id: "job_2",
          jobType: "prd.evaluate_quality",
          status: "pending"
        }
      ],
      documents: [
        {
          id: "doc_wi_1",
          type: "prd",
          currentVersionId: "docv_1"
        }
      ]
    });
    expect(tree).toMatchObject({
      run: {
        id: "run_1"
      },
      tasks: [
        {
          id: "task_wi_1",
          currentDocumentId: "doc_wi_1"
        }
      ],
      nodes: [
        {
          id: "task_wi_1",
          type: "workflow_task",
          currentDocumentId: "doc_wi_1"
        },
        {
          id: "job_1",
          type: "workflow_job",
          primaryDocumentId: "doc_wi_1"
        },
        {
          id: "job_2",
          type: "workflow_job",
          primaryDocumentId: "doc_wi_1"
        }
      ],
      edges: [
        {
          id: "edge_task_wi_1_job_1",
          type: "workflow_task_job",
          from: "task_wi_1",
          to: "job_1"
        },
        {
          id: "edge_task_wi_1_job_2",
          type: "workflow_task_job",
          from: "task_wi_1",
          to: "job_2"
        }
      ]
    });
  });

  it("exposes generic document current and history views separately", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/prd/feedback-revision`, {
      prdJiraKey: "PRD-100",
      requestedBy: "planner@example.com",
      feedback: "Add success metric."
    });
    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const current = await getJson(`${baseUrl}/documents/doc_wi_1/current`);
    const history = await getJson(`${baseUrl}/documents/doc_wi_1/versions`);

    expect(current).toMatchObject({
      document: {
        id: "doc_wi_1",
        currentVersionId: "docv_2",
        currentMarkdownArtifactId: "art_3",
        currentWikiArtifactId: "art_4"
      },
      currentVersion: {
        id: "docv_2",
        version: 2,
        producerJobId: "job_3",
        revisionSummary: "Add success metric.",
        revisionJobId: "job_3"
      },
      latestQualityResult: {
        id: "qgr_2",
        documentVersionId: "docv_2",
        evaluatorJobId: "job_4",
        status: "passed",
        score: 91
      },
      currentArtifacts: [
        {
          id: "art_3",
          type: "document_markdown",
          location: "git"
        },
        {
          id: "art_4",
          type: "wiki_page",
          location: "wiki"
        }
      ]
    });
    expect(history).toMatchObject({
      documentId: "doc_wi_1",
      versions: [
        {
          id: "docv_1",
          version: 1,
          producerJobId: "job_1"
        },
        {
          id: "docv_2",
          version: 2,
          producerJobId: "job_3"
        }
      ],
      qualityResults: [
        {
          id: "qgr_1",
          documentVersionId: "docv_1",
          evaluatorJobId: "job_2",
          status: "needs_revision",
          score: 72,
          missingInformation: ["Success metric is missing"]
        },
        {
          id: "qgr_2",
          documentVersionId: "docv_2",
          evaluatorJobId: "job_4",
          status: "passed",
          score: 91,
          summary: "PRD quality gate passed"
        }
      ],
      artifacts: [
        { id: "art_1", documentVersionId: "docv_1" },
        { id: "art_2", documentVersionId: "docv_1" },
        { id: "art_3", documentVersionId: "docv_2" },
        { id: "art_4", documentVersionId: "docv_2" }
      ]
    });
  });
});

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function getJson<T extends Record<string, any> = Record<string, any>>(url: string): Promise<T> {
  const response = await fetch(url);

  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function tickMany(baseUrl: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await postJson(`${baseUrl}/tick`, {});
  }
}

async function waitFor<T>(
  load: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 750
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() <= deadline) {
    lastValue = await load();

    if (predicate(lastValue)) {
      return lastValue;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}
