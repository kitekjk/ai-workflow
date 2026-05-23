export type WorkflowJobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "canceled"
  | "skipped"
  | "retrying";

export type RunnerMode = "managed" | "local";
export type RunnerStatus = "online" | "offline" | "busy" | "disabled";
export type ExecutionPolicy = "managed_only" | "local_allowed" | "local_required" | "assigned_runner_only";
export type WorkflowTaskType = "prd" | "hld" | "lld" | "adr" | "spec" | "code" | (string & {});
export type WorkflowDocumentType = "prd" | "hld" | "lld" | "adr" | "spec";
export type WorkflowTaskStatus =
  | "draft"
  | "quality_review"
  | "needs_revision"
  | "approval_pending"
  | "approved"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowCommandJobStatus = "pending" | "claimed" | "running" | "succeeded" | "failed";
export type WorkflowCommandJobType =
  | "prd.generate_draft"
  | "prd.evaluate_quality"
  | "prd.apply_feedback_revision"
  | "prd.route_downstream"
  | "document.generate"
  | "document.evaluate"
  | "document.revise"
  | "document.fan_out"
  | "implementation.open_pr"
  | "implementation.update_pr"
  | "implementation.collect_pr_status";

export interface WorkflowCommandJob {
  id: string;
  workItemId?: string;
  jobType: WorkflowCommandJobType;
  primaryJiraKey: string;
  status: WorkflowCommandJobStatus;
  input: Record<string, unknown>;
}

export type ApprovalSource = "jira_status";
export type ApprovalAction = "jira_transition";
export type RevisionTrigger = "explicit_request";
export type ApprovalRole = "planner" | "developer" | "decision_owner";

export interface WorkflowApprovalTransitionPolicy {
  pendingStatus: string;
  approvedStatus: string;
  rejectedStatus: string;
  needsRevisionStatus: string;
}

export interface WorkflowPolicy {
  version: "prd-confirmation-policy-v1";
  approvalSource: ApprovalSource;
  approvalAction: ApprovalAction;
  approvalRoles: Record<WorkflowDocumentType, ApprovalRole>;
  approvalTransition: WorkflowApprovalTransitionPolicy;
  downstreamStart: "after_jira_approved_status";
  qualityFailureAction: "human_clarification" | "auto_rewrite" | "manual_or_auto";
  revisionTrigger: RevisionTrigger;
  feedbackSources: Array<"app" | "jira" | "wiki" | "github">;
}

export const prdConfirmationWorkflowPolicy: WorkflowPolicy = {
  version: "prd-confirmation-policy-v1",
  approvalSource: "jira_status",
  approvalAction: "jira_transition",
  approvalRoles: {
    prd: "planner",
    hld: "developer",
    lld: "developer",
    adr: "decision_owner",
    spec: "developer"
  },
  approvalTransition: {
    pendingStatus: "awaiting_approval",
    approvedStatus: "approved",
    rejectedStatus: "rejected",
    needsRevisionStatus: "needs_revision"
  },
  downstreamStart: "after_jira_approved_status",
  qualityFailureAction: "human_clarification",
  revisionTrigger: "explicit_request",
  feedbackSources: ["app", "jira", "wiki", "github"]
};

export interface WorkflowEngineWorkItemState {
  workItemId: string;
  before: string;
  after: string;
}

export interface WorkflowEngineExternalIssueStatus {
  issueKey: string;
  before?: string;
  after?: string;
}

export type WorkflowEngineTransitionType =
  | "job_failed"
  | "prd_draft_generated"
  | "prd_quality_passed"
  | "prd_quality_needs_revision"
  | "prd_feedback_revision_applied"
  | "prd_downstream_scope_confirmation_required"
  | "prd_downstream_documents_created"
  | "document_fan_out_created"
  | "document_generated"
  | "document_quality_passed"
  | "document_quality_needs_revision"
  | "document_revision_applied"
  | "implementation_pr_opened"
  | "implementation_pr_updated"
  | "implementation_pr_reviewed"
  | "implementation_pr_merged"
  | "implementation_pr_in_review"
  | "implementation_rework_requested"
  | "implementation_revision_requested";

export interface WorkflowRun {
  id: string;
  workflowDefinitionId: string;
  status: "active" | "paused" | "completed" | "canceled" | "failed";
  sourceType: "jira" | "app" | "github";
  sourceKey: string;
  outputLanguage: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTask {
  id: string;
  runId: string;
  parentTaskId?: string;
  taskType: WorkflowTaskType;
  sourceKey: string;
  title: string;
  status: WorkflowTaskStatus;
  currentDocumentId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowJob {
  id: string;
  runId: string;
  taskId?: string;
  jobType: string;
  status: WorkflowJobStatus;
  input: Record<string, unknown>;
  priority: number;
  projectId?: string;
  repositoryId?: string;
  assignedUserId?: string;
  assignedTeamId?: string;
  requiredRole?: string;
  requiredCapabilities: string[];
  preferredEngine?: string;
  requiredEngine?: string;
  executionPolicy: ExecutionPolicy;
  assignedRunnerId?: string;
  claimedByRunnerId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowJobResult {
  id: string;
  jobId: string;
  runnerId?: string;
  attemptNo: number;
  status: "succeeded" | "failed" | "canceled";
  output: Record<string, unknown>;
  errorCategory?: RunnerFailureCategory;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

export type RunnerFailureCategory =
  | "dependency"
  | "workspace"
  | "engine"
  | "result_contract"
  | "artifact"
  | "cancellation"
  | "github"
  | "unknown";

export interface WorkflowEvent {
  id: string;
  runId: string;
  jobId?: string;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Runner {
  id: string;
  ownerUserId?: string;
  mode: RunnerMode;
  status: RunnerStatus;
  teamIds: string[];
  allowedProjectIds: string[];
  allowedRepositoryIds: string[];
  capabilities: string[];
  engines: string[];
  defaultEngine?: string;
  concurrency: number;
  lastHeartbeatAt?: string;
}

export interface ClaimJobInput {
  runnerId: string;
  now: Date;
  leaseMs: number;
  runnerOfflineAfterMs?: number;
}

export interface ClaimJobResult {
  job: WorkflowJob;
  runner: Runner;
}

export type RunnerClaimBlocker =
  | "runner_unavailable"
  | "job_not_available"
  | "lease_active"
  | "execution_policy_mismatch"
  | "assigned_runner_mismatch"
  | "owner_mismatch"
  | "team_mismatch"
  | "project_mismatch"
  | "repository_mismatch"
  | "capability_mismatch"
  | "engine_mismatch";

export type RunnerClaimDiagnosticReason =
  | "claim_available"
  | "runner_offline"
  | "runner_disabled"
  | "runner_capacity_full"
  | "no_available_job"
  | "no_matching_job";

export interface RunnerClaimDiagnostics {
  runnerId: string;
  reason: RunnerClaimDiagnosticReason;
  message: string;
  runnerStatus: RunnerStatus;
  activeJobCount?: number;
  concurrency?: number;
  candidateJobCount?: number;
  nearestJobId?: string;
  nearestBlocker?: RunnerClaimBlocker;
}

export function runnerStatusAt(runner: Runner, now: Date, offlineAfterMs: number | undefined): RunnerStatus {
  if (runner.status === "disabled" || offlineAfterMs === undefined) {
    return runner.status;
  }

  if (!runner.lastHeartbeatAt) {
    return "offline";
  }

  const lastHeartbeat = Date.parse(runner.lastHeartbeatAt);

  if (Number.isNaN(lastHeartbeat) || now.getTime() - lastHeartbeat > offlineAfterMs) {
    return "offline";
  }

  return runner.status;
}

export function canRunnerClaimJob(runner: Runner, job: WorkflowJob, now: Date): boolean {
  return runnerJobClaimBlocker(runner, job, now) === undefined;
}

export function runnerJobClaimBlocker(runner: Runner, job: WorkflowJob, now: Date): RunnerClaimBlocker | undefined {
  if (runner.status === "disabled" || runner.status === "offline") {
    return "runner_unavailable";
  }

  if (job.status !== "pending" && job.status !== "retrying") {
    return "job_not_available";
  }

  if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now.getTime()) {
    return "lease_active";
  }

  if (job.executionPolicy === "managed_only" && runner.mode !== "managed") {
    return "execution_policy_mismatch";
  }

  if (job.executionPolicy === "local_required" && runner.mode !== "local") {
    return "execution_policy_mismatch";
  }

  if (job.executionPolicy === "assigned_runner_only" && job.assignedRunnerId !== runner.id) {
    return "assigned_runner_mismatch";
  }

  if (runner.mode === "local") {
    if (!runner.ownerUserId || job.assignedUserId !== runner.ownerUserId) {
      return "owner_mismatch";
    }
  }

  if (job.assignedTeamId && !runner.teamIds.includes(job.assignedTeamId)) {
    return "team_mismatch";
  }

  if (!isAllowed(job.projectId, runner.allowedProjectIds)) {
    return "project_mismatch";
  }

  if (!isAllowed(job.repositoryId, runner.allowedRepositoryIds)) {
    return "repository_mismatch";
  }

  if (!isSubset(job.requiredCapabilities, runner.capabilities)) {
    return "capability_mismatch";
  }

  if (job.requiredEngine && !runner.engines.includes(job.requiredEngine)) {
    return "engine_mismatch";
  }

  if (!job.requiredEngine && job.preferredEngine && !runner.engines.includes(job.preferredEngine)) {
    return "engine_mismatch";
  }

  return undefined;
}

function isAllowed(value: string | undefined, allowedValues: string[]): boolean {
  return !value || allowedValues.length === 0 || allowedValues.includes(value);
}

function isSubset(required: string[], available: string[]): boolean {
  return required.every((capability) => available.includes(capability));
}
