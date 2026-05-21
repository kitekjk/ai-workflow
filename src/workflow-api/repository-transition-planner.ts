import { randomUUID } from "node:crypto";
import type { Document, DocumentStatus, DocumentType } from "../document-core/domain";
import type { WorkflowEngineTransitionType } from "../prd-confirmation/workflow-engine";
import type { WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import type { WorkflowMutation } from "./workflow-mutation-applier";

export interface PlanRepositoryWorkflowTransitionInput {
  document: Document;
  job: WorkflowJob;
  result: WorkflowJobResult;
  now: Date;
  idGenerator?: (prefix: string) => string;
}

export interface RepositoryWorkflowTransitionPlan {
  transitionType: WorkflowEngineTransitionType;
  mutation: WorkflowMutation;
}

export const repositoryWorkflowTransitionJobTypes = [
  "prd.generate_draft",
  "prd.evaluate_quality",
  "prd.apply_feedback_revision",
  "prd.route_downstream",
  "document.generate",
  "document.evaluate",
  "document.revise",
  "document.fan_out",
  "implementation.open_pr",
  "implementation.collect_pr_status"
] as const;

export function planRepositoryWorkflowTransition(
  input: PlanRepositoryWorkflowTransitionInput
): RepositoryWorkflowTransitionPlan {
  const idGenerator = input.idGenerator ?? defaultIdGenerator;
  const now = input.now.toISOString();
  const transition = repositoryTransitionFor(input, idGenerator, now);
  const document = {
    ...input.document,
    status: transition.documentStatus,
    updatedAt: now
  };

  return {
    transitionType: transition.transitionType,
    mutation: {
      documentStates: [document],
      documents: transition.documents,
      workflowJobs: transition.workflowJobs,
      events: [
        {
          runId: input.job.runId,
          jobId: input.result.jobId,
          type: "workflow.engine_transition",
          message: `Workflow engine transition: ${transition.transitionType}`,
          metadata: {
            transitionType: transition.transitionType,
            source: "repository",
            processedResult: {
              resultId: input.result.id,
              jobId: input.result.jobId,
              jobType: input.job.jobType,
              status: resultStatusFor(input.result)
            },
            qualityStatus: transition.qualityStatus,
            documentIds: [input.document.id, ...transition.documents.map((child) => child.id)],
            createdDocumentIds: transition.documents.map((child) => child.id),
            createdJobIds: transition.workflowJobs.map((job) => job.id)
          },
          createdAt: now
        }
      ]
    }
  };
}

export function canPlanRepositoryWorkflowTransition(jobType: string): boolean {
  return repositoryWorkflowTransitionJobTypes.includes(
    jobType as (typeof repositoryWorkflowTransitionJobTypes)[number]
  );
}

interface RepositoryTransition {
  transitionType: WorkflowEngineTransitionType;
  documentStatus: DocumentStatus;
  documents: Document[];
  workflowJobs: WorkflowJob[];
  qualityStatus?: string;
}

function repositoryTransitionFor(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  if (input.result.status === "failed" || input.result.output.status === "failed") {
    return {
      transitionType: "job_failed",
      documentStatus: "canceled",
      documents: [],
      workflowJobs: []
    };
  }

  if (input.job.jobType === "prd.generate_draft") {
    return {
      transitionType: "prd_draft_generated",
      documentStatus: "quality_review",
      documents: [],
      workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))]
    };
  }

  if (input.job.jobType === "prd.apply_feedback_revision") {
    return {
      transitionType: "prd_feedback_revision_applied",
      documentStatus: "quality_review",
      documents: [],
      workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))]
    };
  }

  if (input.job.jobType === "document.generate") {
    return {
      transitionType: "document_generated",
      documentStatus: "quality_review",
      documents: [],
      workflowJobs: [createFollowUpJob(input, "document.evaluate", nextJobInputFor(input.document, "document.evaluate"))]
    };
  }

  if (input.job.jobType === "document.revise") {
    return {
      transitionType: "document_revision_applied",
      documentStatus: "quality_review",
      documents: [],
      workflowJobs: [createFollowUpJob(input, "document.evaluate", nextJobInputFor(input.document, "document.evaluate"))]
    };
  }

  if (input.job.jobType === "prd.evaluate_quality" || input.job.jobType === "document.evaluate") {
    const passed = resultStatusFor(input.result) === "passed";
    return {
      transitionType: qualityTransitionTypeFor(input.job.jobType, passed),
      documentStatus: passed ? "approval_pending" : "needs_revision",
      documents: [],
      workflowJobs: [],
      qualityStatus: passed ? "passed" : "needs_revision"
    };
  }

  if (input.job.jobType === "prd.route_downstream") {
    if (input.result.output.status === "needs_scope_confirmation") {
      return {
        transitionType: "prd_downstream_scope_confirmation_required",
        documentStatus: "needs_revision",
        documents: [],
        workflowJobs: []
      };
    }

    const created = createDownstreamDocuments(input, downstreamDocumentsFor(input.result), {
      route: input.result.output.route,
      routeRationale: input.result.output.rationale
    }, idGenerator, now);

    return {
      transitionType: "prd_downstream_documents_created",
      documentStatus: input.document.status,
      ...created
    };
  }

  if (input.job.jobType === "document.fan_out") {
    const created = createDownstreamDocuments(input, downstreamDocumentsForFanOut(input.document, input.result), {
      fanOutRationale: input.result.output.rationale,
      parentDocumentType: input.document.type
    }, idGenerator, now);

    return {
      transitionType: "document_fan_out_created",
      documentStatus: input.document.status,
      ...created
    };
  }

  if (input.job.jobType === "implementation.open_pr") {
    const pullNumber = positiveIntegerOrUndefined(input.result.output.pullRequestNumber);
    const pullRequestUrl = stringOrUndefined(input.result.output.pullRequestUrl);
    const documentVersionId = stringOrUndefined(input.result.output.documentVersionId) ?? stringOrUndefined(input.job.input.documentVersionId);
    const workflowJobs = pullNumber
      ? [
          createFollowUpJob(input, "implementation.collect_pr_status", {
            documentType: input.document.type,
            documentId: input.document.id,
            documentVersionId,
            pullNumber,
            pullRequestUrl
          }, idGenerator)
        ]
      : [];

    return {
      transitionType: "implementation_pr_opened",
      documentStatus: input.document.status,
      documents: [],
      workflowJobs
    };
  }

  if (input.job.jobType === "implementation.collect_pr_status") {
    const reviewed = input.result.output.reviewStatus === "approved" && input.result.output.ciStatus === "success";

    return {
      transitionType: reviewed ? "implementation_pr_reviewed" : "implementation_pr_in_review",
      documentStatus: input.document.status,
      documents: [],
      workflowJobs: []
    };
  }

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
}

function createFollowUpJob(
  input: PlanRepositoryWorkflowTransitionInput,
  jobType: string,
  jobInput: Record<string, unknown>,
  idGenerator: (prefix: string) => string = input.idGenerator ?? defaultIdGenerator
): WorkflowJob {
  return createWorkflowJobRecord({
    id: idGenerator("job"),
    runId: input.job.runId,
    jobType,
    input: jobInput,
    projectId: input.job.projectId,
    repositoryId: input.job.repositoryId,
    assignedUserId: input.job.assignedUserId,
    assignedTeamId: input.job.assignedTeamId,
    preferredEngine: input.job.preferredEngine,
    requiredEngine: input.job.requiredEngine,
    executionPolicy: input.job.executionPolicy,
    now: input.now
  });
}

function qualityTransitionTypeFor(jobType: string, passed: boolean): WorkflowEngineTransitionType {
  if (jobType === "prd.evaluate_quality") {
    return passed ? "prd_quality_passed" : "prd_quality_needs_revision";
  }

  return passed ? "document_quality_passed" : "document_quality_needs_revision";
}

function nextJobInputFor(document: Document, jobType: string): Record<string, unknown> {
  if (jobType === "prd.evaluate_quality" || jobType === "document.evaluate") {
    return {
      documentType: document.type,
      sourceDocumentId: document.id
    };
  }

  return {};
}

function createDownstreamDocuments(
  input: PlanRepositoryWorkflowTransitionInput,
  downstreamDocuments: Array<{ type: DocumentType; title?: string }>,
  metadata: Record<string, unknown>,
  idGenerator: (prefix: string) => string,
  now: string
): Pick<RepositoryTransition, "documents" | "workflowJobs"> {
  const documents: Document[] = [];
  const workflowJobs: WorkflowJob[] = [];
  const typeCounts = new Map<DocumentType, number>();

  for (const downstreamDocument of downstreamDocuments) {
    const sequence = (typeCounts.get(downstreamDocument.type) ?? 0) + 1;
    typeCounts.set(downstreamDocument.type, sequence);

    const documentId = idGenerator("doc");
    const title = downstreamDocument.title ?? `${downstreamDocument.type.toUpperCase()} for ${input.document.sourceKey}`;
    const document: Document = {
      id: documentId,
      workflowRunId: input.document.workflowRunId,
      parentDocumentId: input.document.id,
      type: downstreamDocument.type,
      sourceKey: `${input.document.sourceKey}-${downstreamDocument.type.toUpperCase()}-${sequence}`,
      title,
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
    const job = createFollowUpJob(input, "document.generate", {
      ...metadata,
      documentType: document.type,
      sourceDocumentId: document.id,
      parentDocumentId: input.document.id,
      title
    }, idGenerator);

    documents.push(document);
    workflowJobs.push(job);
  }

  return { documents, workflowJobs };
}

function downstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result);

  if (explicit.length > 0) {
    return explicit;
  }

  const route = documentTypeOrUndefined(result.output.route);
  return route ? [{ type: route }] : [{ type: "hld" }];
}

function downstreamDocumentsForFanOut(
  parentDocument: Document,
  result: WorkflowJobResult
): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result).filter((document) => document.type !== parentDocument.type);

  if (explicit.length > 0) {
    return explicit;
  }

  if (parentDocument.type === "hld") {
    return [
      {
        type: "lld",
        title: `Backend LLD for ${parentDocument.sourceKey}`
      },
      {
        type: "lld",
        title: `Frontend LLD for ${parentDocument.sourceKey}`
      }
    ];
  }

  if (parentDocument.type === "lld") {
    return [
      {
        type: "spec",
        title: `Implementation Spec 1 for ${parentDocument.sourceKey}`
      },
      {
        type: "spec",
        title: `Implementation Spec 2 for ${parentDocument.sourceKey}`
      }
    ];
  }

  return [];
}

function explicitDownstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  if (!Array.isArray(result.output.downstreamDocuments)) {
    return [];
  }

  return result.output.downstreamDocuments.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const type = documentTypeOrUndefined(candidate.type);

    if (!type) {
      return [];
    }

    return [
      {
        type,
        title: stringOrUndefined(candidate.title)
      }
    ];
  });
}

function resultStatusFor(result: WorkflowJobResult): string {
  return typeof result.output.status === "string" ? result.output.status : result.status;
}

function documentTypeOrUndefined(value: unknown): DocumentType | undefined {
  return value === "prd" || value === "hld" || value === "lld" || value === "adr" || value === "spec"
    ? value
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
