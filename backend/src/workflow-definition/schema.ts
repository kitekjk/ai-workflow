import type { WorkflowDocumentType, WorkflowCommandJobType } from "../workflow-core/domain";

export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  documentTypes: WorkflowDocumentType[];
  entryStage: string;
  policy: WorkflowPolicyConfig;
  stages: Record<string, WorkflowStage>;
}

export interface WorkflowPolicyConfig {
  approvalSource: "jira_status";
  qualityFailureAction: "human_clarification" | "auto_rewrite" | "manual_or_auto";
  revisionTrigger: "explicit_request";
  feedbackSources: Array<"app" | "jira" | "wiki" | "github">;
}

export type WorkflowStage =
  | RunnableStage
  | ApprovalGateStage
  | FeedbackWaitStage
  | ManualDecisionStage
  | TerminalStage;

export interface RunnableStage {
  label: string;
  type?: "runnable";
  jobTemplate: JobTemplate;
  on: Partial<Record<JobOnKey, string>>;
}

export interface ApprovalGateStage {
  label: string;
  type: "approval_gate";
  approval: ApprovalConfig;
  on: Partial<Record<"approved" | "rejected" | "needsRevision", string>>;
}

export interface FeedbackWaitStage {
  label: string;
  type: "feedback_wait";
  on: { feedbackReceived: string };
}

export interface ManualDecisionStage {
  label: string;
  type: "manual_decision";
  on: { decided: string };
}

export interface TerminalStage {
  type: "terminal";
  kind: "completed" | "failure";
}

export interface JobTemplate {
  jobType: WorkflowCommandJobType;
  runner: { requiredCapability: string; requiredSkill?: SkillRequirement };
  threshold?: number;
  retry?: { maxAttempts: number; backoffMs?: number };
}

export interface SkillRequirement {
  id: string;
  versionRange: string;
}

export interface ApprovalConfig {
  role: "planner" | "developer" | "decision_owner";
  via: "jira_status";
  jiraTransition: {
    pending: string;
    approved: string;
    rejected: string;
    needsRevision: string;
  };
}

export type JobOnKey =
  | "success" | "failure"
  | "passed" | "needsRevision"
  | "routeDecided" | "needsScopeConfirmation";

export function isRunnableStage(stage: WorkflowStage): stage is RunnableStage {
  return stage.type === undefined || stage.type === "runnable";
}

export function isApprovalGateStage(stage: WorkflowStage): stage is ApprovalGateStage {
  return (stage as ApprovalGateStage).type === "approval_gate";
}

export function isFeedbackWaitStage(stage: WorkflowStage): stage is FeedbackWaitStage {
  return (stage as FeedbackWaitStage).type === "feedback_wait";
}

export function isManualDecisionStage(stage: WorkflowStage): stage is ManualDecisionStage {
  return (stage as ManualDecisionStage).type === "manual_decision";
}

export function isTerminalStage(stage: WorkflowStage): stage is TerminalStage {
  return (stage as TerminalStage).type === "terminal";
}
