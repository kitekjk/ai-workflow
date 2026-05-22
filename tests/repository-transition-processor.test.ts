import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult, WorkflowRun, WorkflowTask } from "../src/workflow-core/domain";
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

  it("selects the primary document from the first-class task link before job input fallbacks", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor(
        [
          document({
            id: "doc_stale",
            sourceKey: "PRD-OLD",
            status: "quality_review"
          }),
          document({
            id: "doc_current",
            workflowTaskId: "task_current",
            sourceKey: "PRD-CURRENT",
            status: "quality_review"
          })
        ],
        workflowRun(),
        [
          workflowTask({
            id: "task_current",
            sourceKey: "PRD-CURRENT",
            currentDocumentId: "doc_current"
          })
        ]
      ),
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
        taskId: "task_current",
        input: {
          sourceDocumentId: "doc_stale"
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
    expect(transitions[0]).toMatchObject({
      mutation: {
        documentStates: [
          {
            id: "doc_current",
            status: "approval_pending"
          }
        ],
        workflowTasks: [
          expect.objectContaining({
            id: "task_current",
            currentDocumentId: "doc_current",
            status: "approval_pending"
          })
        ]
      }
    });
  });

  it("uses a task link embedded in job input before document id fallbacks", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor(
        [
          document({
            id: "doc_stale",
            sourceKey: "PRD-OLD",
            status: "quality_review"
          }),
          document({
            id: "doc_current",
            workflowTaskId: "task_current",
            sourceKey: "PRD-CURRENT",
            status: "quality_review"
          })
        ],
        workflowRun(),
        [
          workflowTask({
            id: "task_current",
            sourceKey: "PRD-CURRENT",
            currentDocumentId: "doc_current"
          })
        ]
      ),
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
          taskId: "task_current",
          sourceDocumentId: "doc_stale"
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
    expect(transitions[0]).toMatchObject({
      mutation: {
        documentStates: [
          {
            id: "doc_current",
            status: "approval_pending"
          }
        ]
      }
    });
  });

  it("passes workflow run state so terminal implementation transitions can close the run", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor(
        [
          document({
            id: "doc_spec",
            type: "spec",
            sourceKey: "PRD-100-SPEC-1",
            status: "approved"
          })
        ],
        workflowRun()
      ),
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
        id: "job_collect",
        jobType: "implementation.collect_pr_status",
        taskId: "task_doc_spec_code",
        input: {
          documentId: "doc_spec",
          pullNumber: 42
        }
      }),
      jobResult: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          merged: true
        }
      }),
      now: new Date("2026-05-21T00:02:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "implementation_pr_merged"
    });
    expect(transitions[0]).toMatchObject({
      transitionType: "implementation_pr_merged",
      mutation: {
        workflowRuns: [
          {
            id: "run_1",
            status: "completed",
            updatedAt: "2026-05-21T00:02:00.000Z"
          }
        ],
        workflowTasks: expect.arrayContaining([
          expect.objectContaining({ id: "task_doc_spec_code", status: "completed" })
        ])
      }
    });
  });

  it("keeps the workflow run active when the summary has another open code task", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor(
        [
          document({
            id: "doc_spec",
            type: "spec",
            sourceKey: "PRD-100-SPEC-1",
            status: "approved"
          })
        ],
        workflowRun(),
        [
          workflowTask({
            id: "task_doc_spec_code",
            taskType: "code",
            currentDocumentId: "doc_spec"
          }),
          workflowTask({
            id: "task_doc_lld_code",
            taskType: "code",
            currentDocumentId: "doc_lld"
          })
        ]
      ),
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
        id: "job_collect",
        jobType: "implementation.collect_pr_status",
        taskId: "task_doc_spec_code",
        input: {
          documentId: "doc_spec",
          pullNumber: 42
        }
      }),
      jobResult: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          merged: true
        }
      }),
      now: new Date("2026-05-21T00:02:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "implementation_pr_merged"
    });
    expect(transitions[0]?.mutation.workflowRuns).toBeUndefined();
    expect(transitions[0]?.mutation.workflowTasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "task_doc_spec_code", status: "completed" })])
    );
  });

  it("passes workflow jobs so revised Spec approval can resume blocked code work", async () => {
    const transitions: Array<{ transitionType?: string; mutation: WorkflowMutation }> = [];
    const processor = new RepositoryTransitionProcessor({
      readModel: readModelFor(
        [
          document({
            id: "doc_spec",
            workflowTaskId: "task_spec",
            type: "spec",
            sourceKey: "PRD-100-SPEC-1",
            status: "quality_review",
            currentVersionId: "docv_spec_2"
          })
        ],
        workflowRun(),
        [
          workflowTask({
            id: "task_spec",
            taskType: "spec",
            sourceKey: "PRD-100-SPEC-1",
            status: "quality_review",
            currentDocumentId: "doc_spec"
          }),
          workflowTask({
            id: "task_code",
            parentTaskId: "task_spec",
            taskType: "code",
            sourceKey: "PRD-100-SPEC-1",
            status: "blocked",
            currentDocumentId: "doc_spec"
          })
        ],
        [
          workflowJob({
            id: "job_collect",
            taskId: "task_code",
            jobType: "implementation.collect_pr_status",
            input: {
              taskId: "task_code",
              documentId: "doc_spec",
              pullNumber: 42,
              pullRequestUrl: "https://github.example.com/acme/app/pull/42",
              repositoryCloneUrl: "https://github.example.com/acme/app.git",
              branchName: "workflow/prd-100-spec-1"
            },
            updatedAt: "2026-05-21T00:03:00.000Z"
          })
        ]
      ),
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
        id: "job_evaluate_spec",
        taskId: "task_spec",
        jobType: "document.evaluate",
        input: {
          sourceDocumentId: "doc_spec",
          sourceTaskId: "task_code",
          targetTaskId: "task_spec"
        }
      }),
      jobResult: workflowJobResult({
        id: "result_evaluate_spec",
        jobId: "job_evaluate_spec",
        output: {
          status: "passed",
          score: 90
        }
      }),
      now: new Date("2026-05-21T00:04:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      transitionType: "document_quality_passed"
    });
    expect(transitions[0]).toMatchObject({
      mutation: {
        workflowTasks: expect.arrayContaining([
          expect.objectContaining({ id: "task_code", status: "in_progress" })
        ]),
        workflowJobs: [
          expect.objectContaining({
            taskId: "task_code",
            jobType: "implementation.update_pr",
            input: expect.objectContaining({
              pullNumber: 42,
              pullRequestUrl: "https://github.example.com/acme/app/pull/42",
              repositoryCloneUrl: "https://github.example.com/acme/app.git",
              branchName: "workflow/prd-100-spec-1"
            })
          })
        ]
      }
    });
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

function readModelFor(
  documents: Document[],
  run: Partial<WorkflowRun> = { id: "run_1" },
  tasks: WorkflowTask[] = [],
  jobs: WorkflowJob[] = []
): WorkflowApiReadModel {
  return {
    async summarizeWorkflowRun(runId) {
      return {
        run: { ...run, id: runId },
        jobs,
        documents,
        tasks
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

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run_1",
    workflowDefinitionId: "prd_confirmation",
    status: "active",
    sourceType: "jira",
    sourceKey: "PRD-100",
    outputLanguage: "ko",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides
  };
}

function workflowTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: "task_1",
    runId: "run_1",
    taskType: "prd",
    sourceKey: "PRD-100",
    title: "Task",
    status: "in_progress",
    currentDocumentId: "doc_1",
    metadata: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides
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
