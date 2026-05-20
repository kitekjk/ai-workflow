import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun
} from "./domain";
import { canRunnerClaimJob } from "./domain";
import type {
  AppendWorkflowEventInput,
  AcknowledgeWorkflowJobCancellationInput,
  CompleteWorkflowJobInput,
  CreateWorkflowJobInput,
  CreateWorkflowRunInput,
  FailWorkflowJobInput,
  ListWorkflowEventsInput,
  RecordWorkflowJobResultInput,
  RequestWorkflowJobCancellationInput,
  WorkflowRepository
} from "./repository";

export type { CreateWorkflowJobInput, CreateWorkflowRunInput } from "./repository";

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly workflowRuns: WorkflowRun[] = [];
  readonly workflowJobs: WorkflowJob[] = [];
  readonly workflowJobResults: WorkflowJobResult[] = [];
  readonly workflowEvents: WorkflowEvent[] = [];
  readonly runners: Runner[] = [];

  private runSequence = 1;
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

  createWorkflowJob(input: CreateWorkflowJobInput): WorkflowJob {
    const now = toIso(input.now);
    const job: WorkflowJob = {
      id: `job_${this.jobSequence++}`,
      runId: input.runId,
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

  upsertRunner(runner: Runner): Runner {
    const existing = this.runners.findIndex((candidate) => candidate.id === runner.id);

    if (existing >= 0) {
      this.runners[existing] = runner;
      return this.runners[existing];
    }

    this.runners.push(runner);
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
    const job = this.workflowJobs
      .filter((candidate) => canRunnerClaimJob(runner, candidate, input.now))
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];

    if (!job) {
      return undefined;
    }

    job.status = "claimed";
    job.claimedByRunnerId = runner.id;
    job.claimedAt = input.now.toISOString();
    job.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
    job.updatedAt = input.now.toISOString();

    return { job, runner };
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
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function isTerminalJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "skipped";
}

function isEventAfterCursor(event: WorkflowEvent, cursor: { createdAt: string; id: string }): boolean {
  return event.createdAt > cursor.createdAt || (event.createdAt === cursor.createdAt && event.id > cursor.id);
}
