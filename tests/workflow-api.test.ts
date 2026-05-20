import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { prdConfirmationWorkflowPolicy } from "../src/prd-confirmation/domain";
import type { WikiFeedbackCollector } from "../src/prd-confirmation/ports";
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

describe("Workflow API", () => {
  let server: WorkflowApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    server = await createWorkflowApiServer({ fixture }).listen(0);
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
            type: "prd",
            sourceKey: "PRD-DB",
            title: "Read model PRD",
            status: "approval_pending",
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
      const tree = await getJson(`${localServer.url}/workflow-runs/run_db_1/tree`);
      const current = await getJson(`${localServer.url}/documents/doc_db_1/current`);
      const history = await getJson(`${localServer.url}/documents/doc_db_1/versions`);

      expect(run).toMatchObject({
        run: { id: "run_db_1", sourceKey: "PRD-DB" },
        documents: [{ id: "doc_db_1" }]
      });
      expect(tree).toMatchObject({
        nodes: [{ id: "job_db_1" }]
      });
      expect(current).toMatchObject({
        document: { id: "doc_db_1", title: "Read model PRD" },
        currentVersion: { id: "docv_db_1" },
        approvalGate: { id: "gate_doc_db_1", status: "not_ready" }
      });
      expect(history).toMatchObject({
        documentId: "doc_db_1",
        versions: [{ id: "docv_db_1" }]
      });
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
    expect(tree.nodes.map((node: { jobType: string }) => node.jobType)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.route_downstream",
      "document.generate"
    ]);
    expect(tree.nodes.at(-1)).toMatchObject({
      jobType: "document.generate",
      primaryDocumentId: "doc_wi_2"
    });
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
    expect(tree.nodes.map((node: { jobType: string }) => node.jobType)).toEqual([
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
      nodes: [
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

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function tickMany(baseUrl: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await postJson(`${baseUrl}/tick`, {});
  }
}
