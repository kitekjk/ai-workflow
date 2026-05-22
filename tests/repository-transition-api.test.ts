import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../src/workflow-core/domain";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../src/workflow-core/scheduler";
import type { WorkflowMutation } from "../src/workflow-api/workflow-mutation-applier";
import type { WorkflowApiReadModel } from "../src/workflow-api/mysql-read-model";
import type { RepositoryTransitionPendingResultReader } from "../src/workflow-api/repository-transition-processor";
import { createWorkflowApiServer } from "../src/workflow-api/server";

describe("repository transition API integration", () => {
  it("records repository-backed document transitions after no-fixture runner results", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const now = new Date("2026-05-21T00:00:00.000Z");
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_confirmation",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const job = repository.createWorkflowJob({
      runId: run.id,
      jobType: "prd.evaluate_quality",
      input: {
        documentType: "prd",
        sourceDocumentId: "doc_1"
      },
      requiredCapabilities: ["document.evaluate"],
      now
    });
    await scheduler.registerRunner({
      id: "runner_1",
      mode: "managed",
      capabilities: ["document.evaluate"],
      now
    });
    await scheduler.claim("runner_1", now);

    const document = currentDocument({ workflowRunId: run.id });
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const server = await createWorkflowApiServer({
      scheduler,
      readModel: readModelFor(run.id, job.id, document),
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("legacy document-state command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("legacy job command should not be called");
        },
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      },
      now: () => new Date("2026-05-21T00:01:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${server.url}/runner-jobs/${job.id}/results`, {
        runnerId: "runner_1",
        output: {
          status: "passed"
        }
      });

      expect(response.status).toBe(200);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        transitionType: "prd_quality_passed",
        mutation: {
          documentStates: [
            {
              id: "doc_1",
              status: "approval_pending",
              updatedAt: "2026-05-21T00:01:00.000Z"
            }
          ],
          workflowJobs: [],
          events: [
            {
              runId: run.id,
              jobId: job.id,
              type: "workflow.engine_transition",
              metadata: {
                source: "repository",
                transitionType: "prd_quality_passed",
                qualityStatus: "passed",
                documentIds: ["doc_1"]
              }
            }
          ]
        }
      });
    } finally {
      await server.close();
    }
  });

  it("records repository-backed downstream routing transitions after no-fixture runner results", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const now = new Date("2026-05-21T00:00:00.000Z");
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_confirmation",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const job = repository.createWorkflowJob({
      runId: run.id,
      jobType: "prd.route_downstream",
      input: {
        sourceDocumentId: "doc_prd"
      },
      requiredCapabilities: ["workflow.route"],
      now
    });
    await scheduler.registerRunner({
      id: "runner_1",
      mode: "managed",
      capabilities: ["workflow.route"],
      now
    });
    await scheduler.claim("runner_1", now);

    const document = currentDocument({
      id: "doc_prd",
      workflowRunId: run.id,
      status: "approved"
    });
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const server = await createWorkflowApiServer({
      scheduler,
      readModel: readModelFor(run.id, job.id, document),
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("legacy document-state command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("legacy job command should not be called");
        },
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      },
      now: () => new Date("2026-05-21T00:01:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${server.url}/runner-jobs/${job.id}/results`, {
        runnerId: "runner_1",
        output: {
          status: "routed",
          downstreamDocuments: [
            {
              type: "hld",
              title: "HLD for PRD-100"
            }
          ]
        }
      });

      expect(response.status).toBe(200);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        transitionType: "prd_downstream_documents_created",
        mutation: {
          documents: [
            {
              parentDocumentId: "doc_prd",
              type: "hld",
              sourceKey: "PRD-100-HLD-1",
              title: "HLD for PRD-100"
            }
          ],
          workflowJobs: [
            {
              jobType: "document.generate",
              input: {
                documentType: "hld",
                parentDocumentId: "doc_prd",
                title: "HLD for PRD-100"
              }
            }
          ]
        }
      });
    } finally {
      await server.close();
    }
  });

  it("processes pending repository transition results through the internal repository loop", async () => {
    const document = currentDocument();
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    let readerCalls = 0;
    const server = await createWorkflowApiServer({
      readModel: readModelFor("run_1", "job_1", document),
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("legacy document-state command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("legacy job command should not be called");
        },
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      },
      repositoryTransitionResultReader: {
        async nextPendingJobResult() {
          readerCalls += 1;

          if (readerCalls > 1) {
            return undefined;
          }

          return {
            job: workflowJob({
              input: {
                sourceDocumentId: document.id
              }
            }),
            jobResult: workflowJobResult({
              output: {
                status: "passed"
              }
            })
          };
        }
      },
      repositoryTransitionIntervalMs: 5,
      now: () => new Date("2026-05-21T00:01:00.000Z")
    }).listen(0);

    try {
      await waitFor(() => Promise.resolve(transitions.length), (count) => count === 1);

      expect(transitions[0]).toMatchObject({
        transitionType: "prd_quality_passed",
        mutation: {
          documentStates: [
            {
              id: document.id,
              status: "approval_pending",
              updatedAt: "2026-05-21T00:01:00.000Z"
            }
          ]
        }
      });
    } finally {
      await server.close();
    }
  });

  it("does not record repository transitions at request time when the repository loop owns processing", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const now = new Date("2026-05-21T00:00:00.000Z");
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_confirmation",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const job = repository.createWorkflowJob({
      runId: run.id,
      jobType: "prd.evaluate_quality",
      input: {
        sourceDocumentId: "doc_1"
      },
      requiredCapabilities: ["document.evaluate"],
      now
    });
    await scheduler.registerRunner({
      id: "runner_1",
      mode: "managed",
      capabilities: ["document.evaluate"],
      now
    });
    await scheduler.claim("runner_1", now);

    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const server = await createWorkflowApiServer({
      scheduler,
      readModel: readModelFor(run.id, job.id, currentDocument({ workflowRunId: run.id })),
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("legacy document-state command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("legacy job command should not be called");
        },
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      },
      repositoryTransitionResultReader: {
        async nextPendingJobResult() {
          return undefined;
        }
      },
      repositoryTransitionIntervalMs: 60_000,
      now: () => new Date("2026-05-21T00:01:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${server.url}/runner-jobs/${job.id}/results`, {
        runnerId: "runner_1",
        output: {
          status: "passed"
        }
      });

      expect(response.status).toBe(200);
      expect(transitions).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("processes one pending repository transition through the API trigger", async () => {
    const document = currentDocument();
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    let markedProcessed: string | undefined;
    const repositoryTransitionResultReader: RepositoryTransitionPendingResultReader & {
      markJobResultProcessed(input: { jobResultId: string; now: Date }): Promise<void>;
    } = {
      async nextPendingJobResult() {
        return {
          job: workflowJob({
            input: {
              sourceDocumentId: document.id
            }
          }),
          jobResult: workflowJobResult({
            id: "result_manual",
            output: {
              status: "passed"
            }
          })
        };
      },
      async markJobResultProcessed(input) {
        markedProcessed = input.jobResultId;
      }
    };
    const server = await createWorkflowApiServer({
      readModel: readModelFor("run_1", "job_1", document),
      workflowTransitionCommand: {
        async recordDocumentState() {
          throw new Error("legacy document-state command should not be called");
        },
        async recordWorkflowJob() {
          throw new Error("legacy job command should not be called");
        },
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      },
      repositoryTransitionResultReader,
      now: () => new Date("2026-05-21T00:01:00.000Z")
    }).listen(0);

    try {
      const response = await postJson(`${server.url}/repository-transitions/process-next`, {});

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        processed: true,
        transitionType: "prd_quality_passed"
      });
      expect(transitions).toHaveLength(1);
      expect(markedProcessed).toBe("result_manual");
    } finally {
      await server.close();
    }
  });
});

function readModelFor(runId: string, jobId: string, document: Document): WorkflowApiReadModel {
  return {
    async summarizeWorkflowRun(candidateRunId) {
      expect(candidateRunId).toBe(runId);
      return {
        run: {
          id: runId
        },
        jobs: [
          {
            id: jobId
          }
        ],
        documents: [document]
      };
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
}

function currentDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc_1",
    workflowRunId: "run_1",
    type: "prd",
    sourceKey: "PRD-100",
    title: "PRD",
    status: "quality_review",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides
  };
}

function workflowJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: "job_1",
    runId: "run_1",
    jobType: "prd.evaluate_quality",
    status: "succeeded",
    input: {},
    priority: 0,
    requiredCapabilities: [],
    executionPolicy: "local_allowed",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides
  };
}

function workflowJobResult(overrides: Partial<WorkflowJobResult> = {}): WorkflowJobResult {
  return {
    id: "result_1",
    jobId: "job_1",
    attemptNo: 1,
    status: "succeeded",
    output: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    ...overrides
  };
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
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
