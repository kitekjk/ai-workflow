import type { ExecutionPolicy, WorkflowJob, WorkflowJobStatus } from "./domain";

export interface CreateWorkflowJobRecordInput {
  id: string;
  runId: string;
  taskId?: string;
  jobType: string;
  status?: WorkflowJobStatus;
  input?: Record<string, unknown>;
  priority?: number;
  projectId?: string;
  repositoryId?: string;
  assignedUserId?: string;
  assignedTeamId?: string;
  preferredEngine?: string;
  requiredEngine?: string;
  executionPolicy?: ExecutionPolicy;
  assignedRunnerId?: string;
  claimedByRunnerId?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  now?: Date;
  createdAt?: string;
  updatedAt?: string;
}

export function createWorkflowJobRecord(input: CreateWorkflowJobRecordInput): WorkflowJob {
  const timestamp = input.now?.toISOString() ?? input.createdAt ?? new Date().toISOString();

  return {
    id: input.id,
    runId: input.runId,
    taskId: input.taskId,
    jobType: input.jobType,
    status: input.status ?? "pending",
    input: input.input ?? {},
    priority: input.priority ?? 0,
    projectId: input.projectId ?? "prd-confirmation",
    repositoryId: input.repositoryId ?? "prd-docs",
    assignedUserId: input.assignedUserId,
    assignedTeamId: input.assignedTeamId,
    requiredRole: requiredRoleForWorkflowJobType(input.jobType),
    requiredCapabilities: requiredCapabilitiesForWorkflowJobType(input.jobType),
    preferredEngine: input.preferredEngine,
    requiredEngine: input.requiredEngine,
    executionPolicy: input.executionPolicy ?? "local_allowed",
    assignedRunnerId: input.assignedRunnerId,
    claimedByRunnerId: input.claimedByRunnerId,
    claimedAt: input.claimedAt,
    leaseExpiresAt: input.leaseExpiresAt,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp
  };
}

export function requiredCapabilitiesForWorkflowJobType(jobType: string): string[] {
  if (
    jobType === "implementation.open_pr" ||
    jobType === "implementation.update_pr" ||
    jobType === "implementation.collect_pr_status"
  ) {
    return [jobType];
  }

  if (jobType === "prd.evaluate_quality" || jobType === "document.evaluate") {
    return ["document.evaluate"];
  }

  if (jobType === "prd.route_downstream") {
    return ["workflow.route"];
  }

  if (jobType === "document.fan_out") {
    return ["workflow.fanout"];
  }

  if (jobType === "document.revise") {
    return ["document.revise"];
  }

  return ["document.generate"];
}

export function requiredRoleForWorkflowJobType(jobType: string): string {
  if (
    jobType.startsWith("implementation.") ||
    jobType === "prd.evaluate_quality" ||
    jobType === "prd.route_downstream" ||
    jobType.startsWith("document.")
  ) {
    return "developer";
  }

  return "planner";
}
