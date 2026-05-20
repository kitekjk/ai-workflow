import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun
} from "./domain";

export type Awaitable<T> = T | Promise<T>;

export interface CreateWorkflowRunInput {
  workflowDefinitionId: string;
  sourceType: WorkflowRun["sourceType"];
  sourceKey: string;
  outputLanguage?: string;
  now?: Date;
}

export interface CreateWorkflowJobInput {
  runId: string;
  jobType: string;
  input?: Record<string, unknown>;
  priority?: number;
  projectId?: string;
  repositoryId?: string;
  assignedUserId?: string;
  assignedTeamId?: string;
  requiredRole?: string;
  requiredCapabilities?: string[];
  preferredEngine?: string;
  requiredEngine?: string;
  executionPolicy?: WorkflowJob["executionPolicy"];
  assignedRunnerId?: string;
  now?: Date;
}

export interface RecordWorkflowJobResultInput {
  jobId: string;
  runnerId?: string;
  status: WorkflowJobResult["status"];
  output: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  now?: Date;
}

export interface CompleteWorkflowJobInput {
  jobId: string;
  runnerId: string;
  output: Record<string, unknown>;
  now: Date;
}

export interface FailWorkflowJobInput {
  jobId: string;
  runnerId: string;
  output: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
  retryable?: boolean;
  now: Date;
}

export interface RequestWorkflowJobCancellationInput {
  jobId: string;
  requestedBy?: string;
  reason?: string;
  now: Date;
}

export interface AcknowledgeWorkflowJobCancellationInput {
  jobId: string;
  runnerId: string;
  output: Record<string, unknown>;
  now: Date;
}

export interface AppendWorkflowEventInput {
  runId: string;
  jobId?: string;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface ListWorkflowEventsInput {
  runId?: string;
  jobId?: string;
  type?: string;
  after?: WorkflowEventCursor;
  limit?: number;
}

export interface WorkflowEventCursor {
  createdAt: string;
  id: string;
}

export interface WorkflowRepository {
  createWorkflowRun(input: CreateWorkflowRunInput): Awaitable<WorkflowRun>;
  createWorkflowJob(input: CreateWorkflowJobInput): Awaitable<WorkflowJob>;
  getWorkflowJob(jobId: string): Awaitable<WorkflowJob | undefined>;
  upsertRunner(runner: Runner): Awaitable<Runner>;
  heartbeatRunner(runnerId: string, now: Date): Awaitable<Runner>;
  claimNextJob(input: ClaimJobInput): Awaitable<ClaimJobResult | undefined>;
  startClaimedJob(jobId: string, runnerId: string, now: Date): Awaitable<WorkflowJob>;
  completeJob(input: CompleteWorkflowJobInput): Awaitable<WorkflowJobResult>;
  failJob(input: FailWorkflowJobInput): Awaitable<WorkflowJobResult>;
  requestJobCancellation(input: RequestWorkflowJobCancellationInput): Awaitable<WorkflowJob>;
  acknowledgeJobCancellation(input: AcknowledgeWorkflowJobCancellationInput): Awaitable<WorkflowJobResult>;
  recoverExpiredLeases(now: Date): Awaitable<WorkflowJob[]>;
  recordJobResult(input: RecordWorkflowJobResultInput): Awaitable<WorkflowJobResult>;
  appendEvent(input: AppendWorkflowEventInput): Awaitable<WorkflowEvent>;
  listWorkflowEvents(input: ListWorkflowEventsInput): Awaitable<WorkflowEvent[]>;
}
