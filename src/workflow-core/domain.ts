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
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

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
