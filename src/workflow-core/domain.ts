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

export interface WorkflowJob {
  id: string;
  runId: string;
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
}

export interface ClaimJobResult {
  job: WorkflowJob;
  runner: Runner;
}

export function canRunnerClaimJob(runner: Runner, job: WorkflowJob, now: Date): boolean {
  if (runner.status === "disabled" || runner.status === "offline") {
    return false;
  }

  if (job.status !== "pending" && job.status !== "retrying") {
    return false;
  }

  if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now.getTime()) {
    return false;
  }

  if (job.executionPolicy === "managed_only" && runner.mode !== "managed") {
    return false;
  }

  if (job.executionPolicy === "local_required" && runner.mode !== "local") {
    return false;
  }

  if (job.executionPolicy === "assigned_runner_only" && job.assignedRunnerId !== runner.id) {
    return false;
  }

  if (runner.mode === "local" && job.assignedUserId !== runner.ownerUserId) {
    return false;
  }

  if (job.assignedTeamId && !runner.teamIds.includes(job.assignedTeamId)) {
    return false;
  }

  if (!isAllowed(job.projectId, runner.allowedProjectIds)) {
    return false;
  }

  if (!isAllowed(job.repositoryId, runner.allowedRepositoryIds)) {
    return false;
  }

  if (!isSubset(job.requiredCapabilities, runner.capabilities)) {
    return false;
  }

  if (job.requiredEngine && !runner.engines.includes(job.requiredEngine)) {
    return false;
  }

  if (!job.requiredEngine && job.preferredEngine && !runner.engines.includes(job.preferredEngine)) {
    return false;
  }

  return true;
}

function isAllowed(value: string | undefined, allowedValues: string[]): boolean {
  return !value || allowedValues.length === 0 || allowedValues.includes(value);
}

function isSubset(required: string[], available: string[]): boolean {
  return required.every((capability) => available.includes(capability));
}
