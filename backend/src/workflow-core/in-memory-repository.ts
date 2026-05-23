import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  RunnerClaimDiagnostics,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "./domain";
import { canRunnerClaimJob, runnerJobClaimBlocker, runnerStatusAt } from "./domain";
import type {
  AppendWorkflowEventInput,
  AcknowledgeWorkflowJobCancellationInput,
  CompleteWorkflowJobInput,
  CreateWorkflowJobInput,
  CreateWorkflowRunInput,
  CreateWorkflowTaskInput,
  FailWorkflowJobInput,
  ListWorkflowEventsInput,
  RecordWorkflowJobResultInput,
  RenewWorkflowJobLeaseInput,
  RequestWorkflowJobCancellationInput,
  RequestWorkflowJobRetryInput,
  UpdateWorkflowTaskInput,
  WorkflowRepository
} from "./repository";

export type { CreateWorkflowJobInput, CreateWorkflowRunInput, CreateWorkflowTaskInput } from "./repository";

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly workflowRuns: WorkflowRun[] = [];
  readonly workflowTasks: WorkflowTask[] = [];
  readonly workflowJobs: WorkflowJob[] = [];
  readonly workflowJobResults: WorkflowJobResult[] = [];
  readonly workflowEvents: WorkflowEvent[] = [];
  readonly runners: Runner[] = [];

  private runSequence = 1;
  private taskSequence = 1;
  private jobSequence = 1;
  private resultSequence = 1;
  private eventSequence = 1;

  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
    const now = toIso(input.now);
    const run: WorkflowRun = {
      id: `run_${this.runSequence++}`,
      workflowDefinitionId: input.workflowDefinitionId,
      status: "active",
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      outputLanguage: input.outputLanguage ?? "ko",
      createdAt: now,
      updatedAt: now
    };

    this.workflowRuns.push(run);
    return run;
  }

  createWorkflowTask(input: CreateWorkflowTaskInput): WorkflowTask {
    const now = toIso(input.now);
    const task: WorkflowTask = {
      id: `task_${this.taskSequence++}`,
      runId: input.runId,
      parentTaskId: input.parentTaskId,
      taskType: input.taskType,
      sourceKey: input.sourceKey,
      title: input.title,
      status: input.status ?? "draft",
      currentDocumentId: input.currentDocumentId,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    };

    this.workflowTasks.push(task);
    return task;
  }

  getWorkflowTask(taskId: string): WorkflowTask | undefined {
    return this.workflowTasks.find((candidate) => candidate.id === taskId);
  }

  listWorkflowTasks(runId: string): WorkflowTask[] {
    return this.workflowTasks
      .filter((task) => task.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  updateWorkflowTask(input: UpdateWorkflowTaskInput): WorkflowTask {
    const task = this.requireTask(input.taskId);
    task.status = input.status ?? task.status;
    task.currentDocumentId = input.currentDocumentId ?? task.currentDocumentId;
    task.metadata = input.metadata ?? task.metadata;
    task.updatedAt = toIso(input.now);
    return task;
  }

  createWorkflowJob(input: CreateWorkflowJobInput): WorkflowJob {
    const now = toIso(input.now);
    const job: WorkflowJob = {
      id: `job_${this.jobSequence++}`,
      runId: input.runId,
      taskId: input.taskId,
      jobType: input.jobType,
      status: "pending",
      input: input.input ?? {},
      priority: input.priority ?? 0,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      assignedUserId: input.assignedUserId,
      assignedTeamId: input.assignedTeamId,
      requiredRole: input.requiredRole,
      requiredCapabilities: input.requiredCapabilities ?? [],
      preferredEngine: input.preferredEngine,
      requiredEngine: input.requiredEngine,
      executionPolicy: input.executionPolicy ?? "local_allowed",
      assignedRunnerId: input.assignedRunnerId,
      createdAt: now,
      updatedAt: now
    };

    this.workflowJobs.push(job);
    return job;
  }

  getWorkflowJob(jobId: string): WorkflowJob | undefined {
    return this.workflowJobs.find((candidate) => candidate.id === jobId);
  }

  listWorkflowJobs(runId: string): WorkflowJob[] {
    return this.workflowJobs
      .filter((job) => job.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  upsertRunner(runner: Runner): Runner {
    const existing = this.runners.findIndex((candidate) => candidate.id === runner.id);
    const nextRunner =
      existing >= 0 && this.runners[existing].status === "disabled"
        ? {
            ...runner,
            status: "disabled" as const
          }
        : runner;

    if (existing >= 0) {
      this.runners[existing] = nextRunner;
      return this.runners[existing];
    }

    this.runners.push(nextRunner);
    return nextRunner;
  }

  listRunners(): Runner[] {
    return [...this.runners].sort((left, right) => left.id.localeCompare(right.id));
  }

  setRunnerStatus(runnerId: string, status: Runner["status"], now: Date): Runner {
    const runner = this.requireRunner(runnerId);
    runner.status = status;
    runner.lastHeartbeatAt = now.toISOString();
    return runner;
  }

  heartbeatRunner(runnerId: string, now: Date): Runner {
    const runner = this.requireRunner(runnerId);
    runner.status = runner.status === "disabled" ? "disabled" : "online";
    runner.lastHeartbeatAt = now.toISOString();
    return runner;
  }

  claimNextJob(input: ClaimJobInput): ClaimJobResult | undefined {
    const runner = this.requireRunner(input.runnerId);
    const effectiveRunner: Runner = {
      ...runner,
      status: runnerStatusAt(runner, input.now, input.runnerOfflineAfterMs)
    };

    if (effectiveRunner.status === "offline" || effectiveRunner.status === "disabled") {
      return undefined;
    }

    if (this.activeRunnerJobCount(effectiveRunner.id, input.now) >= Math.max(1, effectiveRunner.concurrency)) {
      return undefined;
    }

    const job = this.workflowJobs
      .filter((candidate) => canRunnerClaimJob(effectiveRunner, candidate, input.now))
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];

    if (!job) {
      return undefined;
    }

    job.status = "claimed";
    job.claimedByRunnerId = effectiveRunner.id;
    job.claimedAt = input.now.toISOString();
    job.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
    job.updatedAt = input.now.toISOString();

    return { job, runner: effectiveRunner };
  }

  diagnoseClaim(input: ClaimJobInput): RunnerClaimDiagnostics {
    const runner = this.requireRunner(input.runnerId);
    const effectiveRunner: Runner = {
      ...runner,
      status: runnerStatusAt(runner, input.now, input.runnerOfflineAfterMs)
    };

    if (effectiveRunner.status === "offline") {
      return claimDiagnostics(effectiveRunner, "runner_offline", "Runner heartbeat is stale or missing.");
    }

    if (effectiveRunner.status === "disabled") {
      return claimDiagnostics(effectiveRunner, "runner_disabled", "Runner is disabled.");
    }

    const activeJobCount = this.activeRunnerJobCount(effectiveRunner.id, input.now);
    const concurrency = Math.max(1, effectiveRunner.concurrency);

    if (activeJobCount >= concurrency) {
      return claimDiagnostics(effectiveRunner, "runner_capacity_full", "Runner is already at concurrency capacity.", {
        activeJobCount,
        concurrency
      });
    }

    const candidates = this.claimCandidates(input.now);
    const nearestJob = candidates[0];

    if (!nearestJob) {
      return claimDiagnostics(effectiveRunner, "no_available_job", "No pending or retrying jobs are available.", {
        activeJobCount,
        concurrency,
        candidateJobCount: 0
      });
    }

    const matchingJob = candidates.find((candidate) => canRunnerClaimJob(effectiveRunner, candidate, input.now));

    if (matchingJob) {
      return claimDiagnostics(effectiveRunner, "claim_available", "A matching job is available for this runner.", {
        activeJobCount,
        concurrency,
        candidateJobCount: candidates.length,
        nearestJobId: matchingJob.id
      });
    }

    const nearestBlocker = runnerJobClaimBlocker(effectiveRunner, nearestJob, input.now);

    return claimDiagnostics(effectiveRunner, "no_matching_job", "Pending jobs exist, but none match this runner.", {
      activeJobCount,
      concurrency,
      candidateJobCount: candidates.length,
      nearestJobId: nearestJob.id,
      nearestBlocker
    });
  }

  startClaimedJob(jobId: string, runnerId: string, now: Date): WorkflowJob {
    const job = this.requireJob(jobId);

    if (job.status !== "claimed" || job.claimedByRunnerId !== runnerId) {
      throw new Error(`Job is not claimed by runner ${runnerId}: ${jobId}`);
    }

    job.status = "running";
    job.updatedAt = now.toISOString();
    return job;
  }

  renewJobLease(input: RenewWorkflowJobLeaseInput): WorkflowJob {
    const job = this.requireJob(input.jobId);

    if (job.claimedByRunnerId !== input.runnerId) {
      throw new Error(`Job is not claimed by runner ${input.runnerId}: ${input.jobId}`);
    }

    if (!isRenewableJobStatus(job.status)) {
      throw new Error(`Job lease cannot be renewed while status is ${job.status}: ${input.jobId}`);
    }

    job.leaseExpiresAt = input.leaseExpiresAt.toISOString();
    job.updatedAt = input.now.toISOString();
    return job;
  }

  completeJob(input: CompleteWorkflowJobInput): WorkflowJobResult {
    const job = this.requireJob(input.jobId);

    if (job.claimedByRunnerId !== input.runnerId) {
      throw new Error(`Job is not claimed by runner ${input.runnerId}: ${input.jobId}`);
    }

    if (job.status === "cancel_requested") {
      throw new Error(`Job cancellation requested: ${input.jobId}`);
    }

    const result = this.recordJobResult({
      jobId: input.jobId,
      runnerId: input.runnerId,
      status: "succeeded",
      output: input.output,
      now: input.now
    });

    job.status = "succeeded";
    job.updatedAt = input.now.toISOString();
    return result;
  }

  failJob(input: FailWorkflowJobInput): WorkflowJobResult {
    const job = this.requireJob(input.jobId);

    if (job.claimedByRunnerId !== input.runnerId) {
      throw new Error(`Job is not claimed by runner ${input.runnerId}: ${input.jobId}`);
    }

    if (job.status === "cancel_requested") {
      throw new Error(`Job cancellation requested: ${input.jobId}`);
    }

    const result = this.recordJobResult({
      jobId: input.jobId,
      runnerId: input.runnerId,
      status: "failed",
      output: input.output,
      errorCategory: input.errorCategory,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      now: input.now
    });

    job.status = input.retryable ? "retrying" : "failed";
    job.claimedByRunnerId = undefined;
    job.claimedAt = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = input.now.toISOString();
    return result;
  }

  requestJobCancellation(input: RequestWorkflowJobCancellationInput): WorkflowJob {
    const job = this.requireJob(input.jobId);

    if (isTerminalJobStatus(job.status)) {
      return job;
    }

    if (job.status === "pending" || job.status === "retrying") {
      job.status = "canceled";
      job.claimedByRunnerId = undefined;
      job.claimedAt = undefined;
      job.leaseExpiresAt = undefined;
    } else {
      job.status = "cancel_requested";
    }

    job.updatedAt = input.now.toISOString();
    return job;
  }

  requestJobRetry(input: RequestWorkflowJobRetryInput): WorkflowJob {
    const job = this.requireJob(input.jobId);

    if (!isRetryableTerminalJobStatus(job.status)) {
      throw new Error(`Job is not retryable: ${input.jobId}`);
    }

    job.status = "retrying";
    job.claimedByRunnerId = undefined;
    job.claimedAt = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = input.now.toISOString();
    return job;
  }

  acknowledgeJobCancellation(input: AcknowledgeWorkflowJobCancellationInput): WorkflowJobResult {
    const job = this.requireJob(input.jobId);

    if (job.claimedByRunnerId !== input.runnerId) {
      throw new Error(`Job is not claimed by runner ${input.runnerId}: ${input.jobId}`);
    }

    if (job.status !== "cancel_requested") {
      throw new Error(`Job cancellation not requested: ${input.jobId}`);
    }

    const result = this.recordJobResult({
      jobId: input.jobId,
      runnerId: input.runnerId,
      status: "canceled",
      output: input.output,
      now: input.now
    });

    job.status = "canceled";
    job.claimedByRunnerId = undefined;
    job.claimedAt = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = input.now.toISOString();
    return result;
  }

  recoverExpiredLeases(now: Date): WorkflowJob[] {
    const recovered: WorkflowJob[] = [];

    for (const job of this.workflowJobs) {
      if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now.getTime()) {
        continue;
      }

      if (job.status !== "claimed" && job.status !== "running") {
        continue;
      }

      job.status = "retrying";
      job.claimedByRunnerId = undefined;
      job.claimedAt = undefined;
      job.leaseExpiresAt = undefined;
      job.updatedAt = now.toISOString();
      recovered.push(job);
    }

    return recovered;
  }

  recordJobResult(input: RecordWorkflowJobResultInput): WorkflowJobResult {
    const attemptNo = this.workflowJobResults.filter((result) => result.jobId === input.jobId).length + 1;
    const result: WorkflowJobResult = {
      id: `result_${this.resultSequence++}`,
      jobId: input.jobId,
      runnerId: input.runnerId,
      attemptNo,
      status: input.status,
      output: input.output,
      errorCategory: input.errorCategory,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      createdAt: toIso(input.now)
    };

    this.workflowJobResults.push(result);
    return result;
  }

  appendEvent(input: AppendWorkflowEventInput): WorkflowEvent {
    const event: WorkflowEvent = {
      id: `event_${this.eventSequence++}`,
      runId: input.runId,
      jobId: input.jobId,
      type: input.type,
      message: input.message,
      metadata: input.metadata ?? {},
      createdAt: toIso(input.now)
    };

    this.workflowEvents.push(event);
    return event;
  }

  listWorkflowEvents(input: ListWorkflowEventsInput): WorkflowEvent[] {
    return this.workflowEvents
      .filter((event) => !input.runId || event.runId === input.runId)
      .filter((event) => !input.jobId || event.jobId === input.jobId)
      .filter((event) => !input.type || event.type === input.type)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .filter((event) => !input.after || isEventAfterCursor(event, input.after))
      .slice(0, input.limit ?? 50);
  }

  private activeRunnerJobCount(runnerId: string, now: Date): number {
    return this.workflowJobs.filter((job) => job.claimedByRunnerId === runnerId && isActiveRunnerJob(job, now)).length;
  }

  private claimCandidates(now: Date): WorkflowJob[] {
    return this.workflowJobs
      .filter((candidate) => isClaimCandidate(candidate, now))
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));
  }

  private requireRunner(runnerId: string): Runner {
    const runner = this.runners.find((candidate) => candidate.id === runnerId);

    if (!runner) {
      throw new Error(`Runner not found: ${runnerId}`);
    }

    return runner;
  }

  private requireJob(jobId: string): WorkflowJob {
    const job = this.workflowJobs.find((candidate) => candidate.id === jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return job;
  }

  private requireTask(taskId: string): WorkflowTask {
    const task = this.workflowTasks.find((candidate) => candidate.id === taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function isTerminalJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "skipped";
}

function isRetryableTerminalJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "failed" || status === "canceled" || status === "skipped";
}

function isRenewableJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "claimed" || status === "running" || status === "cancel_requested";
}

function isActiveRunnerJob(job: WorkflowJob, now: Date): boolean {
  if (job.status !== "claimed" && job.status !== "running" && job.status !== "cancel_requested") {
    return false;
  }

  return !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now.getTime();
}

function isClaimCandidate(job: WorkflowJob, now: Date): boolean {
  if (job.status !== "pending" && job.status !== "retrying") {
    return false;
  }

  return !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now.getTime();
}

function claimDiagnostics(
  runner: Runner,
  reason: RunnerClaimDiagnostics["reason"],
  message: string,
  details: Omit<RunnerClaimDiagnostics, "runnerId" | "reason" | "message" | "runnerStatus"> = {}
): RunnerClaimDiagnostics {
  return {
    runnerId: runner.id,
    reason,
    message,
    runnerStatus: runner.status,
    ...details
  };
}

function isEventAfterCursor(event: WorkflowEvent, cursor: { createdAt: string; id: string }): boolean {
  return event.createdAt > cursor.createdAt || (event.createdAt === cursor.createdAt && event.id > cursor.id);
}
