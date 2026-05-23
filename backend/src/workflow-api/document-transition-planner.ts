import type { Document, DocumentType } from "../document-core/domain";
import type { WorkflowJobResult } from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import {
  type RepositoryTransition,
  createDownstreamDocuments,
  createFollowUpJob,
  documentOutputProjection,
  explicitDownstreamDocumentsFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  qualityResultFor,
  qualityTransitionTypeFor,
  resultStatusFor,
  revisionResumeForQualityPass
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the document.* handlers AND the shared
// quality-evaluation handler used by both document.evaluate and prd.evaluate_quality.
export function planDocumentTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "document.generate")  return planDocumentGenerate(input, idGenerator, now);
  if (jobType === "document.revise")    return planDocumentRevise(input, idGenerator, now);
  if (jobType === "document.fan_out")   return planDocumentFanOut(input, idGenerator, now);
  if (jobType === "document.evaluate" || jobType === "prd.evaluate_quality") {
    return planQualityEvaluation(input, idGenerator, now);
  }
  throw new Error(`Unknown document/quality job type: ${jobType}`);
}

// IMPORTANT: planQualityEvaluation must be exported because Task 5's PRD planner
// will call it for prd.evaluate_quality jobs (PRD's own planner delegates that
// jobType to the shared quality handler).
export function planQualityEvaluation(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const passed = resultStatusFor(input.result) === "passed";
  const revisionResume = passed ? revisionResumeForQualityPass(input, idGenerator, now) : undefined;
  return {
    transitionType: qualityTransitionTypeFor(input.job.jobType, passed),
    documentStatus: passed ? "approval_pending" : "needs_revision",
    documents: [],
    workflowTasks: revisionResume?.workflowTasks ?? [],
    workflowJobs: revisionResume?.workflowJobs ?? [],
    qualityResults: [qualityResultFor(input, passed, now)],
    qualityStatus: passed ? "passed" : "needs_revision"
  };
}

function planDocumentGenerate(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const projection = documentOutputProjection(input, now);

  return {
    transitionType: "document_generated",
    documentStatus: "quality_review",
    documents: [],
    workflowTasks: [],
    workflowJobs: [createFollowUpJob(input, "document.evaluate", nextJobInputFor(input.document, "document.evaluate"))],
    ...projection
  };
}

function planDocumentRevise(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const projection = documentOutputProjection(input, now, { revision: true });

  return {
    transitionType: "document_revision_applied",
    documentStatus: "quality_review",
    documents: [],
    workflowTasks: [],
    workflowJobs: [
      createFollowUpJob(input, "document.evaluate", nextRevisionEvaluationInputFor(input, "document.evaluate"))
    ],
    ...projection
  };
}

function planDocumentFanOut(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
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

