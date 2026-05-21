import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../src/workflow-core/domain";
import type { WorkflowApiReadModel } from "../src/workflow-api/mysql-read-model";
import { RepositoryTransitionProcessor } from "../src/workflow-api/repository-transition-processor";
import type { WorkflowMutation } from "../src/workflow-api/workflow-mutation-applier";

describe("RepositoryTransitionProcessor", () => {
  it("plans and records a repository transition for a completed runner result", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
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
      }
    });

    const result = await processor.processJobResult({
      job: workflowJob({
        jobType: "prd.evaluate_quality",
        input: {
          sourceDocumentId: "doc_1"
        }
      }),
      jobResult: workflowJobResult({
        output: {
          status: "passed"
        }
      }),
      now: new Date("2026-05-21T00:00:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "prd_quality_passed"
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      transitionType: "prd_quality_passed",
      mutation: {
        documentStates: [
          {
            id: "doc_1",
            status: "approval_pending",
            updatedAt: "2026-05-21T00:00:00.000Z"
          }
        ]
      }
    });
  });

  it("returns an idle result for job types without repository transition coverage", async () => {
    const transitions: unknown[] = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor([document()]),
      workflowTransitionCommand: {
        async recordDocumentState() {},
        async recordWorkflowJob() {},
        async recordRepositoryTransition(input) {
          transitions.push(input);
        }
      }
    });

    await expect(
      processor.processJobResult({
        job: workflowJob({ jobType: "unknown.custom" }),
        jobResult: workflowJobResult(),
        now: new Date("2026-05-21T00:00:00.000Z")
      })
    ).resolves.toEqual({ processed: false });
    expect(transitions).toEqual([]);
  });

  it("processes the next pending repository transition result from a reader", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
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
      }
    });

    const result = await processor.processNextPendingResult({
      reader: {
        async nextPendingJobResult() {
          return {
            job: workflowJob({
              jobType: "prd.evaluate_quality",
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
      now: new Date("2026-05-21T00:00:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "prd_quality_passed"
    });
    expect(transitions).toHaveLength(1);
  });

  it("returns an idle result when there is no pending repository transition result", async () => {
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor([document()]),
      workflowTransitionCommand: {
        async recordDocumentState() {},
        async recordWorkflowJob() {},
        async recordRepositoryTransition() {
          throw new Error("no transition should be recorded");
        }
      }
    });

    await expect(
      processor.processNextPendingResult({
        reader: {
          async nextPendingJobResult() {
            return undefined;
          }
        },
        now: new Date("2026-05-21T00:00:00.000Z")
      })
    ).resolves.toEqual({ processed: false });
  });
});

function readModelFor(documents: Document[]): WorkflowApiReadModel {
  return {
    async summarizeWorkflowRun(runId) {
      return {
        run: { id: runId },
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
