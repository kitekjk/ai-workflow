import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../src/workflow-core/domain";
import type { WorkflowApiReadModel } from "../src/workflow-api/mysql-read-model";
import { runRepositoryTransitionWorkerOnce } from "../src/workflow-api/repository-transition-worker";
import type { WorkflowMutation } from "../src/workflow-api/workflow-mutation-applier";

describe("runRepositoryTransitionWorkerOnce", () => {
  it("processes one pending repository transition result", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processedClaims: Array<{ jobResultId: string; now: Date }> = [];

    const result = await runRepositoryTransitionWorkerOnce({
      readModel: readModelFor([document()]),
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
          return {
            job: workflowJob({
              input: {
                sourceDocumentId: "doc_1"
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
      repositoryTransitionClaimStore: {
        async markJobResultProcessed(input) {
          processedClaims.push(input);
        }
      },
      now: new Date("2026-05-21T00:00:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "prd_quality_passed"
    });
    expect(transitions).toHaveLength(1);
    expect(processedClaims).toEqual([
      {
        jobResultId: "result_1",
        now: new Date("2026-05-21T00:00:00.000Z")
      }
    ]);
  });

  it("does not mark a claim processed when there is no pending result", async () => {
    const processedClaims: unknown[] = [];

    const result = await runRepositoryTransitionWorkerOnce({
      readModel: readModelFor([document()]),
      workflowTransitionCommand: {
        async recordDocumentState() {},
        async recordWorkflowJob() {},
        async recordRepositoryTransition() {
          throw new Error("no transition should be recorded");
        }
      },
      repositoryTransitionResultReader: {
        async nextPendingJobResult() {
          return undefined;
        }
      },
      repositoryTransitionClaimStore: {
        async markJobResultProcessed(input) {
          processedClaims.push(input);
        }
      },
      now: new Date("2026-05-21T00:00:00.000Z")
    });

    expect(result).toEqual({ processed: false });
    expect(processedClaims).toEqual([]);
  });
});

function readModelFor(documents: Document[]): WorkflowApiReadModel {
  return {
    async summarizeWorkflowRun() {
      return {
        run: { id: "run_1" },
        jobs: [],
        documents
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

function document(overrides: Partial<Document> = {}): Document {
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
