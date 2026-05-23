import type { DocumentType } from "../document-core/domain";
import type { WorkflowJobResult } from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import { planQualityEvaluation } from "./document-transition-planner";
import {
  type RepositoryTransition,
  createDownstreamDocuments,
  createFollowUpJob,
  documentOutputProjection,
  documentTypeOrUndefined,
  explicitDownstreamDocumentsFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the PRD-prefixed handlers, including delegating
// prd.evaluate_quality to the shared quality handler in document-transition-planner.
export function planPrdTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "prd.generate_draft")          return planPrdGenerateDraft(input, idGenerator, now);
  if (jobType === "prd.apply_feedback_revision") return planPrdApplyFeedbackRevision(input, idGenerator, now);
  if (jobType === "prd.evaluate_quality")        return planQualityEvaluation(input, idGenerator, now);
  if (jobType === "prd.route_downstream")        return planPrdRouteDownstream(input, idGenerator, now);
  throw new Error(`Unknown PRD job type: ${jobType}`);
}

function planPrdGenerateDraft(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const projection = documentOutputProjection(input, now);

  return {
    transitionType: "prd_draft_generated",
    documentStatus: "quality_review",
    documents: [],
    workflowTasks: [],
    workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))],
    ...projection
  };
}

function planPrdApplyFeedbackRevision(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const projection = documentOutputProjection(input, now, { revision: true });

  return {
    transitionType: "prd_feedback_revision_applied",
    documentStatus: "quality_review",
    documents: [],
    workflowTasks: [],
    workflowJobs: [
      createFollowUpJob(input, "prd.evaluate_quality", nextRevisionEvaluationInputFor(input, "prd.evaluate_quality"))
    ],
    ...projection
  };
}

function planPrdRouteDownstream(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  if (input.result.output.status === "needs_scope_confirmation") {
    return {
      transitionType: "prd_downstream_scope_confirmation_required",
      documentStatus: "needs_revision",
      documents: [],
      workflowTasks: [],
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

function downstreamDocumentsFor(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result);

  if (explicit.length > 0) {
    return explicit;
  }

  const route = documentTypeOrUndefined(result.output.route);
  return route ? [{ type: route }] : [{ type: "hld" }];
}
