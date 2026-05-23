import type { WorkflowCommandJobType, WorkflowJobResult } from "../workflow-core/domain";
import type { FeedbackItem } from "../document-core/domain";
import type {
  ApprovalGateStage,
  JobOnKey,
  WorkflowDefinition,
  WorkflowStage
} from "./schema";
import {
  isApprovalGateStage,
  isFeedbackWaitStage,
  isManualDecisionStage,
  isRunnableStage,
  isTerminalStage
} from "./schema";

export interface WorkflowInterpreterInput {
  definition: WorkflowDefinition;
  runState: WorkflowRunState;
  event: WorkflowInterpreterEvent;
}

export interface WorkflowRunState {
  runId: string;
  currentStageId: string;
  currentTaskId: string;
  attemptCounts: Record<string, number>;
  metadata: Record<string, unknown>;
}

export type WorkflowInterpreterEvent =
  | { type: "job.completed"; jobType: WorkflowCommandJobType; result: WorkflowJobResult }
  | { type: "feedback.received"; feedback: FeedbackItem }
  | { type: "approval.changed"; status: "approved" | "rejected" | "needs_revision" }
  | { type: "manual.decision"; decision: string };

export interface WorkflowInterpreterOutput {
  transitions: StageTransition[];
  jobsToCreate: JobCreationRequest[];
  externalActions: ExternalAction[];
  terminal: { kind: "completed" | "failed"; reason: string } | null;
  unmatchedEvent?: { stageId: string; eventType: string; eventStatus?: string };
}

export interface StageTransition {
  fromStageId: string;
  toStageId: string;
  reason: string;
}

export interface JobCreationRequest {
  jobType: WorkflowCommandJobType;
  taskId: string;
  input: Record<string, unknown>;
  retry?: { maxAttempts: number; backoffMs?: number };
}

export type ExternalAction =
  | { type: "jira.transition"; issueKey: string; toStatus: string }
  | { type: "jira.comment"; issueKey: string; body: string }
  | { type: "wiki.banner"; documentId: string; banner: string };

export function interpretWorkflowEvent(input: WorkflowInterpreterInput): WorkflowInterpreterOutput {
  const { definition, runState, event } = input;
  const stage = definition.stages[runState.currentStageId];

  if (!stage) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }
  if (isTerminalStage(stage)) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }

  if (event.type === "job.completed") {
    return handleJobCompleted(definition, runState, stage, event);
  }
  if (event.type === "feedback.received" && isFeedbackWaitStage(stage)) {
    return transitionTo(definition, runState, stage.on.feedbackReceived, "feedback received");
  }
  if (event.type === "approval.changed" && isApprovalGateStage(stage)) {
    return handleApprovalChanged(definition, runState, stage, event.status);
  }
  if (event.type === "manual.decision" && isManualDecisionStage(stage)) {
    return transitionTo(definition, runState, stage.on.decided, `manual decision: ${event.decision}`);
  }
  return emptyOutputWithUnmatched(runState.currentStageId, event);
}

function handleJobCompleted(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  stage: WorkflowStage,
  event: { type: "job.completed"; jobType: WorkflowCommandJobType; result: WorkflowJobResult }
): WorkflowInterpreterOutput {
  if (!isRunnableStage(stage)) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }
  if (stage.jobTemplate.jobType !== event.jobType) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }

  const status = resolveResultStatus(event.result);
  const onKey = resultStatusToOnKey(status);

  if (status === "failed" || status === "failure") {
    const attempts = runState.attemptCounts[runState.currentStageId] ?? 0;
    const max = stage.jobTemplate.retry?.maxAttempts ?? 1;
    if (attempts + 1 < max) {
      return {
        transitions: [],
        jobsToCreate: [
          {
            jobType: stage.jobTemplate.jobType,
            taskId: runState.currentTaskId,
            input: {},
            retry: stage.jobTemplate.retry
          }
        ],
        externalActions: [],
        terminal: null
      };
    }
  }

  const target = stage.on[onKey];
  if (!target) {
    return emptyOutputWithUnmatched(runState.currentStageId, event, status);
  }

  return transitionTo(definition, runState, target, `job ${event.jobType} -> ${status}`);
}

function handleApprovalChanged(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  stage: ApprovalGateStage,
  status: "approved" | "rejected" | "needs_revision"
): WorkflowInterpreterOutput {
  const onKey = status === "needs_revision" ? "needsRevision" : status;
  const target = stage.on[onKey];
  if (!target) {
    return emptyOutputWithUnmatched(runState.currentStageId, { type: "approval.changed", status } as WorkflowInterpreterEvent);
  }
  return transitionTo(definition, runState, target, `approval ${status}`);
}

function transitionTo(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  targetStageId: string,
  reason: string
): WorkflowInterpreterOutput {
  const targetStage = definition.stages[targetStageId];
  if (!targetStage) {
    return emptyOutputWithUnmatched(runState.currentStageId, { type: "job.completed" } as WorkflowInterpreterEvent);
  }

  const transitions: StageTransition[] = [
    { fromStageId: runState.currentStageId, toStageId: targetStageId, reason }
  ];

  const jobsToCreate: JobCreationRequest[] = [];
  const externalActions: ExternalAction[] = [];
  let terminal: WorkflowInterpreterOutput["terminal"] = null;

  if (isTerminalStage(targetStage)) {
    terminal = { kind: targetStage.kind === "completed" ? "completed" : "failed", reason };
  } else if (isRunnableStage(targetStage)) {
    jobsToCreate.push({
      jobType: targetStage.jobTemplate.jobType,
      taskId: runState.currentTaskId,
      input: {},
      retry: targetStage.jobTemplate.retry
    });
  } else if (isApprovalGateStage(targetStage)) {
    externalActions.push(externalForApprovalEntry(runState, targetStage));
  }

  return { transitions, jobsToCreate, externalActions, terminal };
}

function externalForApprovalEntry(runState: WorkflowRunState, stage: ApprovalGateStage): ExternalAction {
  const issueKey = String(runState.metadata.sourceKey ?? runState.metadata.prdJiraKey ?? "");
  return {
    type: "jira.transition",
    issueKey,
    toStatus: stage.approval.jiraTransition.pending
  };
}

function resolveResultStatus(result: WorkflowJobResult): string {
  const top = (result as unknown as { status?: string }).status;
  const inner = (result as unknown as { output?: { status?: string } }).output?.status;
  if (typeof inner === "string") return inner;
  if (typeof top === "string") return top;
  return "succeeded";
}

function resultStatusToOnKey(status: string): JobOnKey {
  if (status === "succeeded" || status === "success") return "success";
  if (status === "failed" || status === "failure") return "failure";
  if (status === "passed") return "passed";
  if (status === "needs_revision") return "needsRevision";
  if (status === "route_decided") return "routeDecided";
  if (status === "needs_scope_confirmation") return "needsScopeConfirmation";
  return "success";
}

function emptyOutputWithUnmatched(
  stageId: string,
  event: WorkflowInterpreterEvent | { type: string; status?: string },
  statusHint?: string
): WorkflowInterpreterOutput {
  return {
    transitions: [],
    jobsToCreate: [],
    externalActions: [],
    terminal: null,
    unmatchedEvent: { stageId, eventType: event.type, eventStatus: statusHint }
  };
}
