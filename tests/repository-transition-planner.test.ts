import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../src/workflow-core/domain";
import { planRepositoryWorkflowTransition } from "../src/workflow-api/repository-transition-planner";

describe("repository transition planner", () => {
  it("plans a PRD draft-generated transition without fixture state", () => {
    const now = new Date("2026-05-21T00:00:00.000Z");
    const plan = planRepositoryWorkflowTransition({
      document: document({ status: "draft" }),
      job: workflowJob({ jobType: "prd.generate_draft" }),
      result: workflowJobResult({ output: { status: "succeeded" } }),
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
          reviewStatus: "approved",
          ciStatus: "success"
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
    expect(plan.mutation.events?.[0]?.metadata).toMatchObject({
      transitionType: "implementation_pr_reviewed",
      createdJobIds: []
    });
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
