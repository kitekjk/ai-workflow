import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentType } from "../document-core/domain";
import type { WorkflowJobResult } from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import {
  type RepositoryTransition,
  createDownstreamDocuments,
  createFollowUpJob,
  documentOutputProjection,
  documentTypeOrUndefined,
  explicitDownstreamDocumentsFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  qualityResultFor
} from "./repository-transition-planner-shared";
import { parseWorkflowDefinitionYaml } from "../workflow-definition/parser";
import { validateWorkflowDefinition } from "../workflow-definition/validator";
import type { WorkflowDefinition } from "../workflow-definition/schema";
import {
  interpretWorkflowEvent,
  type WorkflowInterpreterEvent,
  type WorkflowRunState,
  type WorkflowInterpreterOutput
} from "../workflow-definition/interpreter";

let cachedPrdDefinition: WorkflowDefinition | null = null;
let definitionSupplier: (() => WorkflowDefinition) | null = null;

export function setPrdDefinitionSupplier(fn: () => WorkflowDefinition): void {
  definitionSupplier = fn;
  cachedPrdDefinition = null;
}

function getOrLoadPrdDefinition(): WorkflowDefinition {
  if (definitionSupplier) return definitionSupplier();
  if (cachedPrdDefinition) return cachedPrdDefinition;
  const yamlPath = join(process.cwd(), "workflows", "definitions", "prd-confirmation.v1.yaml");
  const source = readFileSync(yamlPath, "utf8");
  const def = parseWorkflowDefinitionYaml(source);
  validateWorkflowDefinition(def);
  cachedPrdDefinition = def;
  return def;
}

function workflowJobResultToEvent(input: PlanRepositoryWorkflowTransitionInput): WorkflowInterpreterEvent {
  return {
    type: "job.completed",
    jobType: input.job.jobType as import("../workflow-core/domain").WorkflowCommandJobType,
    result: input.result
  };
}

function workflowTaskToRunState(input: PlanRepositoryWorkflowTransitionInput): WorkflowRunState {
  const task = (input.workflowTasks ?? []).find((t) => t.id === input.job.taskId);
  return {
    runId: input.job.runId,
    currentStageId: task?.currentStageId ?? defaultStageForJobType(input.job.jobType),
    currentTaskId: input.job.taskId ?? `task_${input.document.id}`,
    attemptCounts: task?.stageAttemptCounts ?? {},
    metadata: {
      sourceKey: input.document.sourceKey,
      prdJiraKey: input.document.sourceKey,
      documentId: input.document.id
    }
  };
}

function defaultStageForJobType(jobType: string): string {
  // Fallback when workflow_task has no currentStageId (legacy tasks created
  // before the pin). Maps each PRD jobType to its source stage.
  if (jobType === "prd.generate_draft") return "prd.draft";
  if (jobType === "prd.apply_feedback_revision") return "prd.revise";
  if (jobType === "prd.evaluate_quality") return "prd.quality";
  if (jobType === "prd.route_downstream") return "prd.routing";
  return "prd.draft";
}

// Public entry: dispatches PRD transitions through the workflow definition interpreter,
// then translates the interpreter's output into the legacy RepositoryTransition shape.
export function planPrdTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const definition = getOrLoadPrdDefinition();
  const event = workflowJobResultToEvent(input);
  const runState = workflowTaskToRunState(input);
  const output = interpretWorkflowEvent({ definition, runState, event });

  return interpreterOutputToRepositoryTransition(input, output, idGenerator, now);
}

function interpreterOutputToRepositoryTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  output: WorkflowInterpreterOutput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  const targetStage = output.transitions[0]?.toStageId;

  if (jobType === "prd.generate_draft" && targetStage === "prd.quality") {
    const projection = documentOutputProjection(input, now);
    return {
      transitionType: "prd_draft_generated",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [createFollowUpJob(input, "prd.evaluate_quality", nextJobInputFor(input.document, "prd.evaluate_quality"))],
      stageTransitions: output.transitions,
      ...projection
    };
  }

  if (jobType === "prd.apply_feedback_revision" && targetStage === "prd.quality") {
    const projection = documentOutputProjection(input, now, { revision: true });
    return {
      transitionType: "prd_feedback_revision_applied",
      documentStatus: "quality_review",
      documents: [],
      workflowTasks: [],
      workflowJobs: [
        createFollowUpJob(input, "prd.evaluate_quality", nextRevisionEvaluationInputFor(input, "prd.evaluate_quality"))
      ],
      stageTransitions: output.transitions,
      ...projection
    };
  }

  if (jobType === "prd.evaluate_quality" && targetStage === "prd.approval") {
    return {
      transitionType: "prd_quality_passed",
      documentStatus: "approval_pending",
      documents: [],
      workflowTasks: [],
      workflowJobs: [],
      qualityResults: [qualityResultFor(input, true, now)],
      qualityStatus: "passed",
      stageTransitions: output.transitions
    };
  }

  if (jobType === "prd.evaluate_quality" && targetStage === "prd.needs_revision") {
    return {
      transitionType: "prd_quality_needs_revision",
      documentStatus: "needs_revision",
      documents: [],
      workflowTasks: [],
      workflowJobs: [],
      qualityResults: [qualityResultFor(input, false, now)],
      qualityStatus: "needs_revision",
      stageTransitions: output.transitions
    };
  }

  if (jobType === "prd.route_downstream") {
    // The interpreter routes needs_scope_confirmation → prd.scale_clarification;
    // route_decided → completed (terminal).
    // For legacy results where output.status is "routed" or "succeeded" (not
    // "route_decided"), the interpreter may return emptyOutputWithUnmatched
    // (targetStage === undefined). Treat anything that is NOT scale_clarification
    // as the downstream-documents success path.
    if (targetStage === "prd.scale_clarification") {
      return {
        transitionType: "prd_downstream_scope_confirmation_required",
        documentStatus: "needs_revision",
        documents: [],
        workflowTasks: [],
        workflowJobs: [],
        stageTransitions: output.transitions
      };
    }
    // Default success path: create downstream documents
    const created = createDownstreamDocuments(
      input,
      downstreamDocumentsForPrd(input.result),
      {
        route: input.result.output.route,
        routeRationale: input.result.output.rationale
      },
      idGenerator,
      now
    );
    return {
      transitionType: "prd_downstream_documents_created",
      documentStatus: input.document.status,
      stageTransitions: output.transitions,
      ...created
    };
  }

  // Fallback (should not be reached for known PRD jobs)
  throw new Error(`Unmapped interpreter output for jobType=${jobType}, targetStage=${targetStage}`);
}

function downstreamDocumentsForPrd(result: WorkflowJobResult): Array<{ type: DocumentType; title?: string }> {
  const explicit = explicitDownstreamDocumentsFor(result);

  if (explicit.length > 0) {
    return explicit;
  }

  const route = documentTypeOrUndefined(result.output.route);
  return route ? [{ type: route }] : [{ type: "hld" }];
}
