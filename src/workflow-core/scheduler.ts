import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  RunnerClaimDiagnostics,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult
} from "./domain";
import { runnerStatusAt } from "./domain";
import type { WorkflowEventCursor } from "./repository";
import type { WorkflowRepository } from "./repository";

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
