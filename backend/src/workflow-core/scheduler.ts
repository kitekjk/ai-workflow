import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  RunnerClaimDiagnostics,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowTask
} from "./domain";
import { runnerStatusAt } from "./domain";
import type { WorkflowEventCursor } from "./repository";
import type { WorkflowRepository } from "./repository";
import { requiredCapabilitiesForWorkflowJobType } from "./job-metadata";

export interface RegisterRunnerInput {
  id: string;
  ownerUserId?: string;
  mode: Runner["mode"];
  teamIds?: string[];
  allowedProjectIds?: string[];
  allowedRepositoryIds?: string[];
  capabilities?: string[];
  engines?: string[];
  defaultEngine?: string;
  concurrency?: number;
  now: Date;
}

export interface ListJobLogsInput {
  jobId: string;
  limit?: number;
  cursor?: string;
}

export interface ListJobLogsResult {
  events: WorkflowEvent[];
  nextCursor?: string;
}

export interface ListRunEventsInput {
  runId: string;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface ListWorkflowEventsResult {
  events: WorkflowEvent[];
  nextCursor?: string;
}

export interface RunnerClaimWithDiagnosticsResult {
  claim?: ClaimJobResult;
  diagnostics?: RunnerClaimDiagnostics;
}

export class WorkflowScheduler {
  private readonly runnerOfflineAfterMs: number;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly options: { leaseMs: number; runnerOfflineAfterMs?: number }
  ) {
    this.runnerOfflineAfterMs = options.runnerOfflineAfterMs ?? options.leaseMs * 2;
  }

  async registerRunner(input: RegisterRunnerInput): Promise<Runner> {
    return this.repository.upsertRunner({
      id: input.id,
      ownerUserId: input.ownerUserId,
      mode: input.mode,
      status: "online",
      teamIds: input.teamIds ?? [],
      allowedProjectIds: input.allowedProjectIds ?? [],
      allowedRepositoryIds: input.allowedRepositoryIds ?? [],
      capabilities: input.capabilities ?? [],
      engines: input.engines ?? [],
      defaultEngine: input.defaultEngine,
      concurrency: input.concurrency ?? 1,
      lastHeartbeatAt: input.now.toISOString()
    });
  }

  async listRunners(now = new Date()): Promise<Runner[]> {
    const runners = await this.repository.listRunners();

    return runners.map((runner) => ({
      ...runner,
      status: runnerStatusAt(runner, now, this.runnerOfflineAfterMs)
    }));
  }

  async heartbeat(runnerId: string, now: Date): Promise<Runner> {
    return this.repository.heartbeatRunner(runnerId, now);
  }

  async pauseRunner(runnerId: string, now: Date): Promise<Runner> {
    return this.repository.setRunnerStatus(runnerId, "disabled", now);
  }

  async resumeRunner(runnerId: string, now: Date): Promise<Runner> {
    return this.repository.setRunnerStatus(runnerId, "online", now);
  }

  async claim(runnerId: string, now: Date): Promise<ClaimJobResult | undefined> {
    return this.repository.claimNextJob(this.claimInput(runnerId, now));
  }

  async claimWithDiagnostics(runnerId: string, now: Date): Promise<RunnerClaimWithDiagnosticsResult> {
    const input = this.claimInput(runnerId, now);
    const claim = await this.repository.claimNextJob(input);

    if (claim) {
      return { claim };
    }

    return {
      diagnostics: await this.repository.diagnoseClaim(input)
    };
  }

  async diagnoseClaim(runnerId: string, now: Date): Promise<RunnerClaimDiagnostics> {
    return this.repository.diagnoseClaim(this.claimInput(runnerId, now));
  }

  private claimInput(runnerId: string, now: Date): ClaimJobInput {
    return {
      runnerId,
      now,
      leaseMs: this.options.leaseMs,
      runnerOfflineAfterMs: this.runnerOfflineAfterMs
    };
  }

  async startJob(jobId: string, runnerId: string, now: Date): Promise<WorkflowJob> {
    return this.repository.startClaimedJob(jobId, runnerId, now);
  }

  async getJob(jobId: string): Promise<WorkflowJob | undefined> {
    return this.repository.getWorkflowJob(jobId);
  }

  async completeJob(input: {
    jobId: string;
    runnerId: string;
    output: Record<string, unknown>;
    now: Date;
  }): Promise<WorkflowJobResult> {
    return this.repository.completeJob(input);
  }

  async failJob(input: {
    jobId: string;
    runnerId: string;
    output: Record<string, unknown>;
    errorCode: string;
    errorMessage: string;
    retryable?: boolean;
    now: Date;
  }): Promise<WorkflowJobResult> {
    const result = await this.repository.failJob(input);
    const job = await this.repository.getWorkflowJob(input.jobId);

    if (job) {
      const retryScheduled = job.status === "retrying";
      await this.repository.appendEvent({
        runId: job.runId,
        jobId: job.id,
        type: retryScheduled ? "job.retry_scheduled" : "job.failed",
        message: retryScheduled ? "Job failed and was scheduled for retry" : "Job failed; no retry will be scheduled",
        metadata: {
          severity: retryScheduled ? "warning" : "critical",
          alert: !retryScheduled,
          runnerId: input.runnerId,
          attemptNo: result.attemptNo,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          retryable: Boolean(input.retryable),
          retryExhausted: !retryScheduled,
          status: job.status,
          metric: retryScheduled ? "workflow_job_retries_total" : "workflow_job_failures_total"
        },
        now: input.now
      });
    }

    return result;
  }

  async recoverExpiredLeases(now: Date): Promise<WorkflowJob[]> {
    const jobs = await this.repository.recoverExpiredLeases(now);

    for (const job of jobs) {
      await this.repository.appendEvent({
        runId: job.runId,
        jobId: job.id,
        type: "job.lease_expired",
        message: "Job lease expired and was scheduled for retry",
        metadata: {
          severity: "warning",
          alert: true,
          status: job.status,
          metric: "workflow_job_lease_expirations_total"
        },
        now
      });
    }

    return jobs;
  }

  async requestJobCancellation(input: {
    jobId: string;
    requestedBy?: string;
    reason?: string;
    now: Date;
  }): Promise<WorkflowJob> {
    const job = await this.repository.requestJobCancellation(input);
    await this.repository.appendEvent({
      runId: job.runId,
      jobId: job.id,
      type: "job.cancel_requested",
      message: "Job cancellation requested",
      metadata: {
        requestedBy: input.requestedBy,
        reason: input.reason,
        status: job.status
      },
      now: input.now
    });

    return job;
  }

  async requestJobRetry(input: {
    jobId: string;
    requestedBy?: string;
    reason?: string;
    now: Date;
  }): Promise<WorkflowJob> {
    const job = await this.repository.requestJobRetry(input);
    const task = await this.reopenTaskForRetriedJob(job, input.now);
    await this.repository.appendEvent({
      runId: job.runId,
      jobId: job.id,
      type: "job.retry_requested",
      message: "Job retry requested",
      metadata: {
        severity: "warning",
        requestedBy: input.requestedBy,
        reason: input.reason,
        status: job.status,
        taskId: task?.id ?? taskIdForJob(job),
        taskStatus: task?.status,
        metric: "workflow_job_manual_retries_total"
      },
      now: input.now
    });

    return job;
  }

  async requestTaskRetry(input: {
    taskId: string;
    requestedBy?: string;
    reason?: string;
    now: Date;
  }): Promise<{ task: WorkflowTask; job: WorkflowJob }> {
    const task = await this.repository.getWorkflowTask(input.taskId);

    if (!task) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

    const jobs = await this.repository.listWorkflowJobs(task.runId);
    const job = latestRetryableJobForTask(jobs, task.id);

    if (!job) {
      throw new Error(`No retryable job found for task: ${input.taskId}`);
    }

    const retriedJob = await this.requestJobRetry({
      jobId: job.id,
      requestedBy: input.requestedBy,
      reason: input.reason,
      now: input.now
    });
    const updatedTask = (await this.repository.getWorkflowTask(task.id)) ?? task;

    return {
      task: updatedTask,
      job: retriedJob
    };
  }

  async requestTaskRevision(input: {
    sourceTaskId: string;
    targetTaskId?: string;
    requestedBy?: string;
    reason?: string;
    feedback?: string;
    now: Date;
  }): Promise<{ sourceTask: WorkflowTask; targetTask: WorkflowTask; job: WorkflowJob }> {
    const sourceTask = await this.repository.getWorkflowTask(input.sourceTaskId);

    if (!sourceTask) {
      throw new Error(`Task not found: ${input.sourceTaskId}`);
    }

    const targetTaskId = input.targetTaskId ?? sourceTask.parentTaskId;

    if (!targetTaskId) {
      throw new Error(`Revision target task not found: ${input.sourceTaskId}`);
    }

    const targetTask = await this.repository.getWorkflowTask(targetTaskId);

    if (!targetTask) {
      throw new Error(`Revision target task not found: ${targetTaskId}`);
    }

    if (targetTask.runId !== sourceTask.runId) {
      throw new Error(`Revision target task belongs to a different run: ${targetTaskId}`);
    }

    const jobType = revisionJobTypeForTask(targetTask);
    const feedback = input.feedback ?? input.reason ?? `Revision requested from task ${sourceTask.id}.`;
    let updatedSourceTask = sourceTask;

    if (sourceTask.id !== targetTask.id && sourceTask.status !== "blocked") {
      updatedSourceTask = await this.repository.updateWorkflowTask({
        taskId: sourceTask.id,
        status: "blocked",
        now: input.now
      });
    }

    const updatedTargetTask =
      targetTask.status === "in_progress"
        ? targetTask
        : await this.repository.updateWorkflowTask({
            taskId: targetTask.id,
            status: "in_progress",
            now: input.now
          });
    const job = await this.repository.createWorkflowJob({
      runId: targetTask.runId,
      taskId: targetTask.id,
      jobType,
      input: {
        taskId: targetTask.id,
        requestedBy: input.requestedBy,
        documentType: targetTask.taskType,
        sourceDocumentId: targetTask.currentDocumentId,
        currentDocumentVersionId: stringOrUndefined(targetTask.metadata.currentDocumentVersionId),
        feedback,
        revisionSource: "workflow.task_revision_request",
        sourceTaskId: sourceTask.id,
        targetTaskId: targetTask.id
      },
      assignedUserId: input.requestedBy,
      requiredCapabilities: requiredCapabilitiesForWorkflowJobType(jobType),
      now: input.now
    });

    await this.repository.appendEvent({
      runId: targetTask.runId,
      jobId: job.id,
      type: "task.revision_requested",
      message: "Task revision requested",
      metadata: {
        severity: "warning",
        requestedBy: input.requestedBy,
        reason: input.reason,
        sourceTaskId: sourceTask.id,
        sourceTaskStatus: updatedSourceTask.status,
        targetTaskId: targetTask.id,
        targetTaskStatus: updatedTargetTask.status,
        jobId: job.id,
        jobType: job.jobType,
        feedback,
        metric: "workflow_task_manual_revision_requests_total"
      },
      now: input.now
    });

    return {
      sourceTask: updatedSourceTask,
      targetTask: updatedTargetTask,
      job
    };
  }

  private async reopenTaskForRetriedJob(job: WorkflowJob, now: Date): Promise<WorkflowTask | undefined> {
    const taskId = taskIdForJob(job);

    if (!taskId) {
      return undefined;
    }

    const task = await this.repository.getWorkflowTask(taskId);

    if (!task) {
      return undefined;
    }

    const status = taskStatusForRetriedJob(job);

    if (task.status === status) {
      return task;
    }

    return this.repository.updateWorkflowTask({
      taskId,
      status,
      now
    });
  }

  async acknowledgeJobCancellation(input: {
    jobId: string;
    runnerId: string;
    output: Record<string, unknown>;
    now: Date;
  }): Promise<WorkflowJobResult> {
    const result = await this.repository.acknowledgeJobCancellation(input);
    const job = await this.repository.getWorkflowJob(input.jobId);

    if (job) {
      await this.repository.appendEvent({
        runId: job.runId,
        jobId: job.id,
        type: "job.canceled",
        message: "Job canceled by runner",
        metadata: {
          runnerId: input.runnerId
        },
        now: input.now
      });
    }

    return result;
  }

  async requireClaimedJob(jobId: string, runnerId: string): Promise<WorkflowJob> {
    const job = await this.repository.getWorkflowJob(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.claimedByRunnerId !== runnerId) {
      throw new Error(`Job is not claimed by runner ${runnerId}: ${jobId}`);
    }

    return job;
  }

  async recordJobLog(input: {
    jobId: string;
    runnerId: string;
    level?: string;
    message: string;
    metadata?: Record<string, unknown>;
    now: Date;
  }): Promise<WorkflowEvent> {
    const job = await this.requireClaimedJob(input.jobId, input.runnerId);

    return this.repository.appendEvent({
      runId: job.runId,
      jobId: job.id,
      type: "runner.log",
      message: input.message,
      metadata: {
        ...(input.metadata ?? {}),
        level: input.level ?? "info",
        runnerId: input.runnerId
      },
      now: input.now
    });
  }

  async listJobLogs(input: ListJobLogsInput): Promise<ListJobLogsResult> {
    return this.listEvents({
      jobId: input.jobId,
      type: "runner.log",
      limit: input.limit,
      cursor: input.cursor
    });
  }

  async listRunEvents(input: ListRunEventsInput): Promise<ListWorkflowEventsResult> {
    return this.listEvents(input);
  }

  private async listEvents(input: {
    runId?: string;
    jobId?: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListWorkflowEventsResult> {
    const limit = input.limit ?? 50;
    const events = await this.repository.listWorkflowEvents({
      runId: input.runId,
      jobId: input.jobId,
      type: input.type,
      after: decodeWorkflowEventCursor(input.cursor),
      limit: limit + 1
    });
    const pageEvents = events.slice(0, limit);

    return {
      events: pageEvents,
      nextCursor: events.length > limit ? encodeWorkflowEventCursor(pageEvents[pageEvents.length - 1]) : undefined
    };
  }
}

function encodeWorkflowEventCursor(event: WorkflowEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }

  return Buffer.from(
    JSON.stringify({
      createdAt: event.createdAt,
      id: event.id
    }),
    "utf8"
  ).toString("base64url");
}

function decodeWorkflowEventCursor(cursor: string | undefined): WorkflowEventCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      return {
        createdAt: (parsed as { createdAt: string }).createdAt,
        id: (parsed as { id: string }).id
      };
    }
  } catch {
    // Fall through to a normalized public error below.
  }

  throw new Error("Invalid event cursor");
}

function taskIdForJob(job: WorkflowJob): string | undefined {
  return job.taskId ?? stringOrUndefined(job.input.taskId);
}

function taskStatusForRetriedJob(job: WorkflowJob): WorkflowTask["status"] {
  return job.jobType === "prd.evaluate_quality" || job.jobType === "document.evaluate"
    ? "quality_review"
    : "in_progress";
}

function latestRetryableJobForTask(jobs: WorkflowJob[], taskId: string): WorkflowJob | undefined {
  return jobs
    .filter((job) => taskIdForJob(job) === taskId && isRetryableTerminalJobStatus(job.status))
    .sort(compareJobsNewestFirst)[0];
}

function isRetryableTerminalJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "failed" || status === "canceled" || status === "skipped";
}

function compareJobsNewestFirst(left: WorkflowJob, right: WorkflowJob): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function revisionJobTypeForTask(task: WorkflowTask): string {
  if (task.taskType === "prd") {
    return "prd.apply_feedback_revision";
  }

  if (
    task.taskType === "hld" ||
    task.taskType === "lld" ||
    task.taskType === "adr" ||
    task.taskType === "spec"
  ) {
    return "document.revise";
  }

  throw new Error(`Revision target task is not revisable: ${task.id}`);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
