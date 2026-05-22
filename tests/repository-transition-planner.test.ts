import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult, WorkflowRun, WorkflowTask } from "../src/workflow-core/domain";
import { planRepositoryWorkflowTransition } from "../src/workflow-api/repository-transition-planner";

describe("repository transition planner", () => {
  it("plans a PRD draft-generated transition without fixture state", () => {
    const now = new Date("2026-05-21T00:00:00.000Z");
    const plan = planRepositoryWorkflowTransition({
      document: document({ status: "draft" }),
      job: workflowJob({ jobType: "prd.generate_draft" }),
      result: workflowJobResult({
        output: {
          status: "succeeded",
          summary: "Draft generated",
          markdown: "# PRD\n\nGenerated draft."
        }
      }),
      now,
      idGenerator: (prefix) => `${prefix}_next`
    });

    expect(plan).toMatchObject({
      transitionType: "prd_draft_generated",
      mutation: {
        documentStates: [
          {
            id: "doc_1",
            status: "quality_review",
            currentVersionId: "docv_doc_1__v1",
            currentMarkdownArtifactId: "art_doc_1__v1_markdown",
            updatedAt: "2026-05-21T00:00:00.000Z"
          }
        ],
        documentVersions: [
          {
            id: "docv_doc_1__v1",
            documentId: "doc_1",
            version: 1,
            producerJobId: "job_1",
            summary: "Draft generated",
            contentHash: expect.any(String),
            createdAt: "2026-05-21T00:00:00.000Z"
          }
        ],
        artifacts: [
          {
            id: "art_doc_1__v1_markdown",
            documentId: "doc_1",
            documentVersionId: "docv_doc_1__v1",
            producerJobId: "job_1",
            type: "document_markdown",
            location: "database",
            uri: "db://workflow-runs/run_1/documents/doc_1/versions/1/markdown",
            contentHash: expect.any(String)
          }
        ],
        documentCurrentPointers: [
          {
            id: "doc_1",
            status: "quality_review",
            currentVersionId: "docv_doc_1__v1",
            currentMarkdownArtifactId: "art_doc_1__v1_markdown",
            updatedAt: "2026-05-21T00:00:00.000Z"
          }
        ],
        workflowJobs: [
          {
            id: "job_next",
            runId: "run_1",
            jobType: "prd.evaluate_quality",
            status: "pending",
            input: {
              documentType: "prd",
              sourceDocumentId: "doc_1"
            },
            requiredRole: "developer",
            requiredCapabilities: ["document.evaluate"],
            executionPolicy: "local_allowed",
            createdAt: "2026-05-21T00:00:00.000Z",
            updatedAt: "2026-05-21T00:00:00.000Z"
          }
        ],
        events: [
          {
            runId: "run_1",
            jobId: "job_1",
            type: "workflow.engine_transition",
            metadata: {
              transitionType: "prd_draft_generated",
              processedResult: {
                resultId: "result_1",
                jobId: "job_1",
                jobType: "prd.generate_draft",
                status: "succeeded"
              },
              documentIds: ["doc_1"],
              createdJobIds: ["job_next"]
            },
            createdAt: "2026-05-21T00:00:00.000Z"
          }
        ]
      }
    });
  });

  it("plans a quality failure transition without scheduling an automatic rewrite", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({ status: "quality_review" }),
      job: workflowJob({ jobType: "prd.evaluate_quality" }),
      result: workflowJobResult({
        output: {
          status: "needs_revision",
          missingInformation: ["Success metric is missing"]
        }
      }),
      now: new Date("2026-05-21T00:01:00.000Z"),
      idGenerator: (prefix) => `${prefix}_unused`
    });

    expect(plan.transitionType).toBe("prd_quality_needs_revision");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_1",
        status: "needs_revision",
        updatedAt: "2026-05-21T00:01:00.000Z"
      }
    ]);
    expect(plan.mutation.workflowJobs).toEqual([]);
    expect(plan.mutation.qualityResults).toMatchObject([
      {
        id: "qg_result_1",
        documentId: "doc_1",
        evaluatorJobId: "job_1",
        status: "needs_revision",
        missingInformation: ["Success metric is missing"],
        createdAt: "2026-05-21T00:01:00.000Z"
      }
    ]);
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "prd_quality_needs_revision",
      qualityStatus: "needs_revision"
    });
  });

  it("plans downstream document creation after PRD routing", () => {
    const idGenerator = sequenceGenerator();
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_prd",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_route",
        jobType: "prd.route_downstream",
        input: {
          sourceDocumentId: "doc_prd"
        }
      }),
      result: workflowJobResult({
        id: "result_route",
        jobId: "job_route",
        output: {
          status: "routed",
          route: "hld",
          rationale: "Needs system design.",
          downstreamDocuments: [
            {
              type: "hld",
              title: "HLD for PRD-100"
            }
          ]
        }
      }),
      now: new Date("2026-05-21T00:02:00.000Z"),
      idGenerator
    });

    expect(plan.transitionType).toBe("prd_downstream_documents_created");
    expect(plan.mutation.documents).toMatchObject([
      {
        id: "doc_1",
        workflowRunId: "run_1",
        parentDocumentId: "doc_prd",
        type: "hld",
        sourceKey: "PRD-100-HLD-1",
        title: "HLD for PRD-100",
        status: "draft"
      }
    ]);
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_2",
        jobType: "document.generate",
        input: {
          route: "hld",
          routeRationale: "Needs system design.",
          documentType: "hld",
          sourceDocumentId: "doc_1",
          parentDocumentId: "doc_prd",
          title: "HLD for PRD-100"
        },
        requiredCapabilities: ["document.generate"]
      }
    ]);
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "prd_downstream_documents_created",
      documentIds: ["doc_prd", "doc_1"],
      createdDocumentIds: ["doc_1"],
      createdJobIds: ["job_2"]
    });
  });

  it("plans default document fan-out for approved HLD documents", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_hld",
        type: "hld",
        sourceKey: "PRD-100-HLD-1",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_fanout",
        jobType: "document.fan_out",
        input: {
          sourceDocumentId: "doc_hld",
          parentDocumentType: "hld",
          targetDocumentType: "lld"
        }
      }),
      result: workflowJobResult({
        id: "result_fanout",
        jobId: "job_fanout",
        output: {
          status: "fanout_ready",
          targetDocumentType: "lld",
          rationale: "HLD is ready for decomposition."
        }
      }),
      now: new Date("2026-05-21T00:03:00.000Z"),
      idGenerator: sequenceGenerator()
    });

    expect(plan.transitionType).toBe("document_fan_out_created");
    expect(plan.mutation.documents).toMatchObject([
      {
        id: "doc_1",
        parentDocumentId: "doc_hld",
        type: "lld",
        sourceKey: "PRD-100-HLD-1-LLD-1",
        title: "Backend LLD for PRD-100-HLD-1"
      },
      {
        id: "doc_3",
        parentDocumentId: "doc_hld",
        type: "lld",
        sourceKey: "PRD-100-HLD-1-LLD-2",
        title: "Frontend LLD for PRD-100-HLD-1"
      }
    ]);
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_2",
        jobType: "document.generate",
        input: {
          fanOutRationale: "HLD is ready for decomposition.",
          parentDocumentType: "hld",
          documentType: "lld",
          sourceDocumentId: "doc_1",
          parentDocumentId: "doc_hld"
        }
      },
      {
        id: "job_4",
        jobType: "document.generate",
        input: {
          documentType: "lld",
          sourceDocumentId: "doc_3",
          parentDocumentId: "doc_hld"
        }
      }
    ]);
  });

  it("plans implementation status collection after opening a pull request", () => {
    const plan = planRepositoryWorkflowTransition({
      workflowRun: workflowRun(),
      document: document({
        id: "doc_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved",
        currentVersionId: "docv_spec_1"
      }),
      job: workflowJob({
        id: "job_pr",
        jobType: "implementation.open_pr",
        input: {
          documentType: "spec",
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1"
        }
      }),
      result: workflowJobResult({
        id: "result_pr",
        jobId: "job_pr",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      now: new Date("2026-05-21T00:04:00.000Z"),
      idGenerator: (prefix) => `${prefix}_collect`
    });

    expect(plan.transitionType).toBe("implementation_pr_opened");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_spec",
        status: "approved"
      }
    ]);
    expect(plan.mutation.artifacts).toMatchObject([
      {
        id: "art_job_pr_pull_request",
        documentId: "doc_spec",
        documentVersionId: "docv_spec_1",
        producerJobId: "job_pr",
        type: "pull_request",
        location: "external",
        uri: "https://github.example.com/acme/app/pull/42",
        externalId: "42",
        metadata: {
          source: "repository_runner_result",
          pullRequestNumber: 42
        }
      }
    ]);
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_collect",
        jobType: "implementation.collect_pr_status",
        input: {
          documentType: "spec",
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        },
        requiredCapabilities: ["implementation.collect_pr_status"]
      }
    ]);
  });

  it("plans implementation review completion from collected PR status", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_collect",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          pullNumber: 42
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          reviewStatus: "approved",
          ciStatus: "success",
          branchName: "feature/spec-100",
          baseBranch: "main",
          latestCommitSha: "reviewed-sha"
        }
      }),
      now: new Date("2026-05-21T00:05:00.000Z"),
      idGenerator: (prefix) => `${prefix}_unused`
    });

    expect(plan.transitionType).toBe("implementation_pr_reviewed");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_spec",
        status: "approved",
        updatedAt: "2026-05-21T00:05:00.000Z"
      }
    ]);
    expect(plan.mutation.workflowJobs).toEqual([]);
    expect(plan.mutation.artifacts).toMatchObject([
      {
        id: "art_job_collect_pull_request",
        documentId: "doc_spec",
        producerJobId: "job_collect",
        type: "pull_request",
        uri: "https://github.example.com/acme/app/pull/42",
        externalId: "42",
        externalVersion: "reviewed-sha",
        metadata: {
          pullRequestNumber: 42,
          branchName: "feature/spec-100",
          baseBranch: "main",
          reviewStatus: "approved",
          ciStatus: "success"
        }
      }
    ]);
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_pr_reviewed",
      createdJobIds: []
    });
  });

  it("treats a merged implementation PR as the terminal implementation transition", () => {
    const plan = planRepositoryWorkflowTransition({
      workflowRun: workflowRun(),
      document: document({
        id: "doc_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_collect",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          pullRequestState: "closed",
          merged: true,
          reviewStatus: "pending",
          ciStatus: "pending",
          latestCommitSha: "merged-sha"
        }
      }),
      now: new Date("2026-05-21T00:05:30.000Z"),
      idGenerator: (prefix) => `${prefix}_unused`
    });

    expect(plan.transitionType).toBe("implementation_pr_merged");
    expect(plan.mutation.workflowRuns).toMatchObject([
      {
        id: "run_1",
        status: "completed",
        updatedAt: "2026-05-21T00:05:30.000Z"
      }
    ]);
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_doc_spec_code",
          taskType: "code",
          status: "completed",
          currentDocumentId: "doc_spec"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toEqual([]);
    expect(plan.mutation.artifacts).toMatchObject([
      {
        id: "art_job_collect_pull_request",
        type: "pull_request",
        uri: "https://github.example.com/acme/app/pull/42",
        externalVersion: "merged-sha",
        metadata: {
          pullRequestState: "closed",
          merged: true,
          reviewStatus: "pending",
          ciStatus: "pending"
        }
      }
    ]);
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_pr_merged",
      workflowRunStatus: "completed"
    });
  });

  it("keeps the workflow run active while another code task is still open", () => {
    const plan = planRepositoryWorkflowTransition({
      workflowRun: workflowRun(),
      workflowTasks: [
        workflowTask({
          id: "task_doc_spec_code",
          taskType: "code",
          status: "in_progress",
          currentDocumentId: "doc_spec"
        }),
        workflowTask({
          id: "task_doc_lld_code",
          taskType: "code",
          status: "in_progress",
          currentDocumentId: "doc_lld"
        })
      ],
      document: document({
        id: "doc_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_collect",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          merged: true
        }
      }),
      now: new Date("2026-05-21T00:05:45.000Z")
    });

    expect(plan.transitionType).toBe("implementation_pr_merged");
    expect(plan.mutation.workflowRuns).toBeUndefined();
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_doc_spec_code",
          taskType: "code",
          status: "completed"
        })
      ])
    );
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_pr_merged"
    });
    expect(plan.mutation.events?.[0]?.metadata).not.toMatchObject({
      workflowRunStatus: "completed"
    });
  });

  it("routes implementation review changes back to the document task", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved",
        currentVersionId: "docv_spec_1"
      }),
      job: workflowJob({
        id: "job_collect",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          reviewStatus: "changes_requested",
          ciStatus: "success",
          feedback: "The endpoint contract is missing rollback behavior."
        }
      }),
      now: new Date("2026-05-21T00:06:00.000Z"),
      idGenerator: (prefix) => `${prefix}_revise`
    });

    expect(plan.transitionType).toBe("implementation_revision_requested");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_spec",
        status: "needs_revision",
        updatedAt: "2026-05-21T00:06:00.000Z"
      }
    ]);
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_spec",
          status: "needs_revision",
          currentDocumentId: "doc_spec"
        }),
        expect.objectContaining({
          id: "task_doc_spec_code",
          taskType: "code",
          status: "blocked",
          currentDocumentId: "doc_spec"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_revise",
        taskId: "task_spec",
        jobType: "document.revise",
        input: {
          taskId: "task_spec",
          requestedBy: "implementation.collect_pr_status",
          documentType: "spec",
          sourceDocumentId: "doc_spec",
          currentDocumentVersionId: "docv_spec_1",
          feedback: expect.stringContaining("rollback behavior"),
          feedbackItemIds: ["fb_result_collect_implementation_review"],
          revisionSource: "implementation.collect_pr_status",
          sourceImplementationJobId: "job_collect",
          sourceImplementationResultId: "result_collect",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          reviewStatus: "changes_requested",
          ciStatus: "success"
        },
        requiredCapabilities: ["document.revise"]
      }
    ]);
    expect(plan.mutation.feedbackItems).toMatchObject([
      {
        id: "fb_result_collect_implementation_review",
        documentId: "doc_spec",
        workItemId: "task_spec",
        source: "github",
        body: expect.stringContaining("rollback behavior"),
        externalId: "42",
        externalUrl: "https://github.example.com/acme/app/pull/42",
        revisionJobId: "job_revise"
      }
    ]);
    expect(plan.mutation.documentEvents).toMatchObject([
      {
        documentId: "doc_spec",
        jobId: "job_revise",
        type: "workflow.feedback_recorded"
      }
    ]);
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_revision_requested",
      createdFeedbackItemIds: ["fb_result_collect_implementation_review"],
      createdJobIds: ["job_revise"]
    });
  });

  it("schedules code-only implementation rework when PR checks fail", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved",
        currentVersionId: "docv_spec_1"
      }),
      job: workflowJob({
        id: "job_collect",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "succeeded",
          reviewStatus: "approved",
          ciStatus: "failure",
          reworkRequired: true,
          failureScope: "implementation",
          repository: "acme/app",
          repositoryCloneUrl: "https://github.example.com/acme/app.git",
          branchName: "feature/spec-100",
          baseBranch: "main",
          latestCommitSha: "head-sha",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "failure"
            }
          ]
        }
      }),
      now: new Date("2026-05-21T00:06:30.000Z"),
      idGenerator: (prefix) => `${prefix}_update`
    });

    expect(plan.transitionType).toBe("implementation_rework_requested");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_spec",
        status: "approved"
      }
    ]);
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_doc_spec_code",
          taskType: "code",
          status: "in_progress",
          currentDocumentId: "doc_spec"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_update",
        taskId: "task_doc_spec_code",
        jobType: "implementation.update_pr",
        input: {
          taskId: "task_doc_spec_code",
          requestedBy: "implementation.collect_pr_status",
          documentType: "spec",
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          repository: "acme/app",
          repositoryCloneUrl: "https://github.example.com/acme/app.git",
          branchName: "feature/spec-100",
          baseBranch: "main",
          latestCommitSha: "head-sha",
          feedback: expect.stringContaining("Failing checks: unit"),
          reworkSource: "implementation.collect_pr_status",
          sourceImplementationJobId: "job_collect",
          sourceImplementationResultId: "result_collect",
          reviewStatus: "approved",
          ciStatus: "failure",
          runnerSkill: {
            id: "implementation.pr-updater",
            version: "0.1.0"
          },
          runnerJobTemplate: {
            runner: {
              sandbox: "workspace-write",
              workdir: "implementation"
            }
          }
        },
        requiredCapabilities: ["implementation.update_pr"]
      }
    ]);
    expect(plan.mutation.feedbackItems).toBeUndefined();
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_rework_requested",
      createdJobIds: ["job_update"]
    });
  });

  it("continues PR status collection after implementation rework updates the PR", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved",
        currentVersionId: "docv_spec_1"
      }),
      job: workflowJob({
        id: "job_update",
        taskId: "task_doc_spec_code",
        jobType: "implementation.update_pr",
        input: {
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42"
        }
      }),
      result: workflowJobResult({
        id: "result_update",
        jobId: "job_update",
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          latestCommitSha: "fix-sha"
        }
      }),
      now: new Date("2026-05-21T00:06:45.000Z"),
      idGenerator: (prefix) => `${prefix}_collect_again`
    });

    expect(plan.transitionType).toBe("implementation_pr_updated");
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_doc_spec_code",
          status: "in_progress"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_collect_again",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          taskId: "task_doc_spec_code",
          documentId: "doc_spec",
          documentVersionId: "docv_spec_1",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          previousImplementationJobId: "job_update"
        }
      }
    ]);
    expect(plan.mutation.artifacts).toMatchObject([
      {
        id: "art_job_update_pull_request",
        type: "pull_request",
        documentId: "doc_spec",
        documentVersionId: "docv_spec_1",
        uri: "https://github.example.com/acme/app/pull/42",
        externalId: "42",
        externalVersion: "fix-sha"
      }
    ]);
  });

  it("can route implementation rework to an explicit upstream task", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "approved"
      }),
      job: workflowJob({
        id: "job_collect",
        taskId: "task_doc_spec_code",
        jobType: "implementation.collect_pr_status",
        input: {
          documentId: "doc_spec",
          pullNumber: 42
        }
      }),
      result: workflowJobResult({
        id: "result_collect",
        jobId: "job_collect",
        output: {
          status: "needs_revision",
          revisionRequired: true,
          revisionTargetDocumentId: "doc_lld",
          revisionTargetDocumentType: "lld",
          revisionTargetTaskId: "task_lld",
          revisionTargetDocumentVersionId: "docv_lld_2",
          reviewStatus: "changes_requested",
          ciStatus: "failure",
          summary: "Implementation exposed an LLD gap."
        }
      }),
      now: new Date("2026-05-21T00:07:00.000Z"),
      idGenerator: (prefix) => `${prefix}_revise_lld`
    });

    expect(plan.transitionType).toBe("implementation_revision_requested");
    expect(plan.mutation.documentStates).toMatchObject([
      {
        id: "doc_spec",
        status: "approved"
      }
    ]);
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_revise_lld",
        taskId: "task_lld",
        jobType: "document.revise",
        input: {
          taskId: "task_lld",
          documentType: "lld",
          sourceDocumentId: "doc_lld",
          currentDocumentVersionId: "docv_lld_2",
          feedback: expect.stringContaining("LLD gap"),
          feedbackItemIds: ["fb_result_collect_implementation_review"]
        }
      }
    ]);
    expect(plan.mutation.feedbackItems).toMatchObject([
      {
        documentId: "doc_lld",
        workItemId: "task_lld",
        source: "github",
        revisionJobId: "job_revise_lld"
      }
    ]);
  });

  it("carries manual revision resume context into the quality evaluation job", () => {
    const plan = planRepositoryWorkflowTransition({
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "needs_revision"
      }),
      job: workflowJob({
        id: "job_revise_spec",
        taskId: "task_spec",
        jobType: "document.revise",
        input: {
          taskId: "task_spec",
          revisionSource: "workflow.task_revision_request",
          sourceTaskId: "task_code",
          targetTaskId: "task_spec",
          sourceDocumentId: "doc_spec"
        }
      }),
      result: workflowJobResult({
        id: "result_revise_spec",
        jobId: "job_revise_spec",
        output: {
          status: "succeeded",
          markdown: "# Revised Spec",
          summary: "Spec revised.",
          revisionSummary: "Clarified rollback behavior."
        }
      }),
      now: new Date("2026-05-21T00:08:00.000Z"),
      idGenerator: sequenceGenerator()
    });

    expect(plan.transitionType).toBe("document_revision_applied");
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_1",
        taskId: "task_spec",
        jobType: "document.evaluate",
        input: {
          documentType: "spec",
          sourceDocumentId: "doc_spec",
          revisionSource: "workflow.task_revision_request",
          sourceTaskId: "task_code",
          targetTaskId: "task_spec"
        }
      }
    ]);
  });

  it("resumes a blocked code task after its revised Spec passes quality", () => {
    const plan = planRepositoryWorkflowTransition({
      workflowTasks: [
        workflowTask({
          id: "task_spec",
          taskType: "spec",
          sourceKey: "PRD-100-SPEC-1",
          title: "Spec",
          status: "quality_review",
          currentDocumentId: "doc_spec"
        }),
        workflowTask({
          id: "task_code",
          parentTaskId: "task_spec",
          taskType: "code",
          sourceKey: "PRD-100-SPEC-1",
          title: "Code Implementation",
          status: "blocked",
          currentDocumentId: "doc_spec"
        })
      ],
      workflowJobs: [
        workflowJob({
          id: "job_collect",
          taskId: "task_code",
          jobType: "implementation.collect_pr_status",
          input: {
            taskId: "task_code",
            documentId: "doc_spec",
            documentVersionId: "docv_spec_1",
            pullNumber: 42,
            pullRequestUrl: "https://github.example.com/acme/app/pull/42",
            repository: "acme/app",
            repositoryCloneUrl: "https://github.example.com/acme/app.git",
            branchName: "workflow/prd-100-spec-1",
            baseBranch: "main"
          },
          updatedAt: "2026-05-21T00:07:00.000Z"
        })
      ],
      document: document({
        id: "doc_spec",
        workflowTaskId: "task_spec",
        type: "spec",
        sourceKey: "PRD-100-SPEC-1",
        status: "quality_review",
        currentVersionId: "docv_spec_2"
      }),
      job: workflowJob({
        id: "job_evaluate_spec",
        taskId: "task_spec",
        jobType: "document.evaluate",
        input: {
          sourceDocumentId: "doc_spec",
          revisionSource: "workflow.task_revision_request",
          sourceTaskId: "task_code",
          targetTaskId: "task_spec"
        }
      }),
      result: workflowJobResult({
        id: "result_evaluate_spec",
        jobId: "job_evaluate_spec",
        output: {
          status: "passed",
          score: 91,
          summary: "Spec quality passed."
        }
      }),
      now: new Date("2026-05-21T00:09:00.000Z"),
      idGenerator: (prefix) => `${prefix}_resume`
    });

    expect(plan.transitionType).toBe("document_quality_passed");
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_spec",
          status: "approval_pending"
        }),
        expect.objectContaining({
          id: "task_code",
          status: "in_progress",
          updatedAt: "2026-05-21T00:09:00.000Z"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_resume",
        taskId: "task_code",
        jobType: "implementation.update_pr",
        input: {
          taskId: "task_code",
          requestedBy: "workflow.task_revision_resume",
          documentType: "spec",
          documentId: "doc_spec",
          documentVersionId: "docv_spec_2",
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/acme/app/pull/42",
          repositoryCloneUrl: "https://github.example.com/acme/app.git",
          branchName: "workflow/prd-100-spec-1",
          reworkSource: "workflow.task_revision_resume",
          sourceRevisionEvaluationJobId: "job_evaluate_spec",
          sourceRevisionEvaluationResultId: "result_evaluate_spec",
          runnerSkill: {
            id: "implementation.pr-updater"
          }
        },
        requiredCapabilities: ["implementation.update_pr"]
      }
    ]);
  });

  it("cascades a revised LLD into a child Spec revision before resuming Code", () => {
    const plan = planRepositoryWorkflowTransition({
      workflowTasks: [
        workflowTask({
          id: "task_lld",
          taskType: "lld",
          sourceKey: "PRD-100-LLD-1",
          title: "LLD",
          status: "quality_review",
          currentDocumentId: "doc_lld"
        }),
        workflowTask({
          id: "task_spec",
          parentTaskId: "task_lld",
          taskType: "spec",
          sourceKey: "PRD-100-SPEC-1",
          title: "Spec",
          status: "completed",
          currentDocumentId: "doc_spec",
          metadata: {
            currentDocumentVersionId: "docv_spec_1"
          }
        }),
        workflowTask({
          id: "task_code",
          parentTaskId: "task_spec",
          taskType: "code",
          sourceKey: "PRD-100-SPEC-1",
          title: "Code Implementation",
          status: "blocked",
          currentDocumentId: "doc_spec"
        })
      ],
      document: document({
        id: "doc_lld",
        workflowTaskId: "task_lld",
        type: "lld",
        sourceKey: "PRD-100-LLD-1",
        status: "quality_review",
        currentVersionId: "docv_lld_2"
      }),
      job: workflowJob({
        id: "job_evaluate_lld",
        taskId: "task_lld",
        jobType: "document.evaluate",
        input: {
          sourceDocumentId: "doc_lld",
          revisionSource: "workflow.task_revision_request",
          sourceTaskId: "task_code",
          targetTaskId: "task_lld"
        }
      }),
      result: workflowJobResult({
        id: "result_evaluate_lld",
        jobId: "job_evaluate_lld",
        output: {
          status: "passed",
          score: 92,
          summary: "LLD quality passed."
        }
      }),
      now: new Date("2026-05-21T00:10:00.000Z"),
      idGenerator: (prefix) => `${prefix}_cascade`
    });

    expect(plan.transitionType).toBe("document_quality_passed");
    expect(plan.mutation.workflowTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_lld",
          status: "approval_pending"
        }),
        expect.objectContaining({
          id: "task_spec",
          status: "in_progress"
        })
      ])
    );
    expect(plan.mutation.workflowJobs).toMatchObject([
      {
        id: "job_cascade",
        taskId: "task_spec",
        jobType: "document.revise",
        input: {
          taskId: "task_spec",
          requestedBy: "workflow.task_revision_resume",
          documentType: "spec",
          sourceDocumentId: "doc_spec",
          currentDocumentVersionId: "docv_spec_1",
          revisionSource: "workflow.task_revision_resume",
          sourceTaskId: "task_code",
          targetTaskId: "task_spec",
          upstreamTaskId: "task_lld",
          upstreamDocumentId: "doc_lld"
        }
      }
    ]);
  });
});

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc_1",
    workflowRunId: "run_1",
    type: "prd",
    sourceKey: "PRD-100",
    title: "PRD",
    status: "draft",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides
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
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
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
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function workflowJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: "job_1",
    runId: "run_1",
    jobType: "prd.generate_draft",
    status: "succeeded",
    input: {},
    priority: 0,
    projectId: "prd-confirmation",
    repositoryId: "prd-docs",
    requiredRole: "planner",
    requiredCapabilities: ["document.generate"],
    executionPolicy: "local_allowed",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
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
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function sequenceGenerator(): (prefix: string) => string {
  let sequence = 0;

  return (prefix) => `${prefix}_${++sequence}`;
}
