import type { Runner, RunnerClaimDiagnostics, WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import { redactSecrets } from "../runtime/secrets";
import type { RegisterRunnerInput } from "../workflow-core/scheduler";
import {
  MissingRunnerPackagesError,
  assertRunnerPackagesInstalled,
  type LocalRunnerPackageResolver
} from "./package-resolver";
import { RunnerResultValidationError, validateLocalRunnerEngineResult } from "./result-schema";
import type { RunnerArtifactUpload, WorkflowApiRunnerClient } from "./runner-client";
import {
  collectGeneratedFileArtifacts,
  prepareJobWorkspace,
  type GeneratedFileReference,
  type LocalRunnerWorkspaceOptions,
  type PreparedJobWorkspace
} from "./workspace";

export interface LocalRunnerEngineInput {
  runner: Runner;
  job: WorkflowJob;
  workspaceDir?: string;
  signal?: AbortSignal;
}

export interface LocalRunnerEngineResult {
  output: Record<string, unknown>;
  artifacts?: RunnerArtifactUpload[];
  generatedFiles?: GeneratedFileReference[];
  logs?: LocalRunnerEngineLog[];
}

export interface LocalRunnerEngineLog {
  level?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface LocalRunnerEngine {
  run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult>;
}

const DEFAULT_JOB_LEASE_RENEWAL_INTERVAL_MS = 10_000;
const DEFAULT_JOB_CANCELLATION_POLL_INTERVAL_MS = 2_000;

export interface LocalRunnerConfig extends Omit<RegisterRunnerInput, "now"> {
  retryableEngineErrors?: boolean;
  jobLeaseRenewalIntervalMs?: number;
  jobCancellationPollIntervalMs?: number;
}

export type LocalRunnerOnceResult =
  | { status: "idle"; runner: Runner; diagnostics?: RunnerClaimDiagnostics }
  | { status: "completed"; runner: Runner; job: WorkflowJob; result: WorkflowJobResult }
  | { status: "canceled"; runner: Runner; job: WorkflowJob; result: WorkflowJobResult }
  | { status: "failed"; runner: Runner; job: WorkflowJob; result: WorkflowJobResult };

export interface RunLocalRunnerOnceInput {
  client: WorkflowApiRunnerClient;
  engine: LocalRunnerEngine;
  runner: LocalRunnerConfig;
  packageResolver?: LocalRunnerPackageResolver;
  workspace?: LocalRunnerWorkspaceOptions;
  now?: Date;
}

export interface RunLocalRunnerDrainInput extends Omit<RunLocalRunnerOnceInput, "now"> {
  maxJobs: number;
  now?: () => Date;
}

export interface LocalRunnerDrainResult {
  stoppedReason: "idle" | "max_jobs";
  processedJobs: number;
  attempts: number;
  results: LocalRunnerOnceResult[];
}

export async function runLocalRunnerDrain(input: RunLocalRunnerDrainInput): Promise<LocalRunnerDrainResult> {
  if (!Number.isInteger(input.maxJobs) || input.maxJobs < 1) {
    throw new Error(`maxJobs must be a positive integer, got: ${input.maxJobs}`);
  }

  const { maxJobs, now, ...onceInput } = input;
  const results: LocalRunnerOnceResult[] = [];
  let processedJobs = 0;

  while (processedJobs < maxJobs) {
    const result = await runLocalRunnerOnce({
      ...onceInput,
      now: now?.()
    });
    results.push(result);

    if (result.status === "idle") {
      return {
        stoppedReason: "idle",
        processedJobs,
        attempts: results.length,
        results
      };
    }

    processedJobs += 1;
  }

  return {
    stoppedReason: "max_jobs",
    processedJobs,
    attempts: results.length,
    results
  };
}

export async function runLocalRunnerOnce(input: RunLocalRunnerOnceInput): Promise<LocalRunnerOnceResult> {
  const now = clock(input.now);
  const { retryableEngineErrors, jobLeaseRenewalIntervalMs, jobCancellationPollIntervalMs, ...runnerRegistration } =
    input.runner;
  const runner = await input.client.registerRunner({
    ...runnerRegistration,
    now: now()
  });
  await input.client.heartbeat(runner.id, now());

  const claimResponse = await input.client.claimWithDiagnostics(runner.id, now());
  const claim = claimResponse.claim ?? undefined;

  if (!claim) {
    return { status: "idle", runner, diagnostics: claimResponse.diagnostics };
  }

  const { job } = claim;
  let workspace: PreparedJobWorkspace | undefined;
  let leaseRenewal: JobLeaseRenewalLoop | undefined;
  let cancellationWatch: JobCancellationWatchLoop | undefined;

  try {
    await input.client.renewJobLease(job.id, runner.id, now());
    leaseRenewal = startJobLeaseRenewalLoop({
      client: input.client,
      jobId: job.id,
      runnerId: runner.id,
      intervalMs: jobLeaseRenewalIntervalMs ?? DEFAULT_JOB_LEASE_RENEWAL_INTERVAL_MS,
      now
    });
    workspace = input.workspace ? await prepareJobWorkspace({ job, workspace: input.workspace }) : undefined;
    if (input.packageResolver) {
      assertRunnerPackagesInstalled(await input.packageResolver.prepare({ job, runner }));
    }

    await input.client.startJob(job.id, runner.id, now());
    cancellationWatch = startJobCancellationWatchLoop({
      client: input.client,
      jobId: job.id,
      intervalMs: jobCancellationPollIntervalMs ?? DEFAULT_JOB_CANCELLATION_POLL_INTERVAL_MS
    });
    await input.client.recordLog({
      jobId: job.id,
      runnerId: runner.id,
      level: "info",
      message: "Job started",
      metadata: {
        jobType: job.jobType,
        workspaceDir: workspace?.workspaceDir
      },
      now: now()
    });

    const engineResult = validateLocalRunnerEngineResult(
      await input.engine.run({
        runner,
        job,
        workspaceDir: workspace?.workspaceDir,
        signal: cancellationWatch.signal
      })
    );

    for (const log of engineResult.logs ?? []) {
      await input.client.recordLog({
        jobId: job.id,
        runnerId: runner.id,
        level: log.level,
        message: log.message,
        metadata: log.metadata,
        now: now()
      });
    }

    const jobAfterEngine = await input.client.getJob(job.id);

    if (jobAfterEngine.status === "cancel_requested") {
      await stopJobCancellationWatchLoop(cancellationWatch);
      cancellationWatch = undefined;
      await stopJobLeaseRenewalLoop(leaseRenewal);
      leaseRenewal = undefined;
      const result = await input.client.acknowledgeCancellation({
        jobId: job.id,
        runnerId: runner.id,
        output: {
          status: "canceled"
        },
        now: now()
      });

      return {
        status: "canceled",
        runner,
        job: jobAfterEngine,
        result
      };
    }

    throwIfJobCancellationRequested(cancellationWatch, job.id);
    const collectedArtifacts =
      workspace && engineResult.generatedFiles
        ? await collectGeneratedFileArtifacts({
            workspaceDir: workspace.workspaceDir,
            files: engineResult.generatedFiles
          })
        : [];

    for (const artifact of [...(engineResult.artifacts ?? []), ...collectedArtifacts]) {
      throwIfJobCancellationRequested(cancellationWatch, job.id);
      await input.client.uploadArtifact({
        jobId: job.id,
        runnerId: runner.id,
        artifact,
        now: now()
      });
    }

    throwIfJobCancellationRequested(cancellationWatch, job.id);
    await stopJobCancellationWatchLoop(cancellationWatch);
    cancellationWatch = undefined;
    await stopJobLeaseRenewalLoop(leaseRenewal);
    leaseRenewal = undefined;
    const result = await input.client.completeJob({
      jobId: job.id,
      runnerId: runner.id,
      output: engineResult.output,
      now: now()
    });

    return {
      status: "completed",
      runner,
      job,
      result
    };
  } catch (error) {
    await stopJobCancellationWatchLoop(cancellationWatch, { swallowErrors: true });
    cancellationWatch = undefined;
    await stopJobLeaseRenewalLoop(leaseRenewal, { swallowErrors: true });
    leaseRenewal = undefined;
    const jobAfterError = await input.client.getJob(job.id).catch(() => undefined);

    if (jobAfterError?.status === "cancel_requested") {
      const result = await input.client.acknowledgeCancellation({
        jobId: job.id,
        runnerId: runner.id,
        output: {
          status: "canceled"
        },
        now: now()
      });

      return {
        status: "canceled",
        runner,
        job: jobAfterError,
        result
      };
    }

    const failure = classifyLocalRunnerFailure(error, retryableEngineErrors ?? true);
    await input.client
      .recordLog({
        jobId: job.id,
        runnerId: runner.id,
        level: "error",
        message: "Job failed",
        metadata: {
          errorCategory: failure.errorCategory,
          errorCode: failure.errorCode,
          retryable: failure.retryable,
          errorMessage: failure.errorMessage
        },
        now: now()
      })
      .catch(() => undefined);

    const result = await input.client.failJob({
      jobId: job.id,
      runnerId: runner.id,
      output: {
        status: "failed",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode
      },
      errorCategory: failure.errorCategory,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      retryable: failure.retryable,
      now: now()
    });

    return {
      status: "failed",
      runner,
      job,
      result
    };
  }
}

interface JobLeaseRenewalLoop {
  stop(): Promise<void>;
}

interface JobCancellationWatchLoop {
  signal: AbortSignal;
  stop(): Promise<void>;
}

function clock(fixedNow: Date | undefined): () => Date {
  return fixedNow ? () => fixedNow : () => new Date();
}

function startJobLeaseRenewalLoop(input: {
  client: WorkflowApiRunnerClient;
  jobId: string;
  runnerId: string;
  intervalMs: number;
  now: () => Date;
}): JobLeaseRenewalLoop {
  const intervalMs = normalizeJobLeaseRenewalInterval(input.intervalMs);
  let renewalError: unknown;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const renew = (): void => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = input.client
      .renewJobLease(input.jobId, input.runnerId, input.now())
      .then(() => undefined)
      .catch((error: unknown) => {
        renewalError = error;
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(renew, intervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;

      if (renewalError) {
        throw renewalError;
      }
    }
  };
}

function startJobCancellationWatchLoop(input: {
  client: WorkflowApiRunnerClient;
  jobId: string;
  intervalMs: number;
}): JobCancellationWatchLoop {
  const intervalMs = normalizeJobCancellationPollInterval(input.intervalMs);
  const abortController = new AbortController();
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const poll = (): void => {
    if (stopped || inFlight || abortController.signal.aborted) {
      return;
    }

    inFlight = input.client
      .getJob(input.jobId)
      .then((job) => {
        if (job.status === "cancel_requested" && !abortController.signal.aborted) {
          abortController.abort(new Error(`Job cancellation requested: ${input.jobId}`));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  poll();

  return {
    signal: abortController.signal,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}

async function stopJobLeaseRenewalLoop(
  loop: JobLeaseRenewalLoop | undefined,
  options: { swallowErrors?: boolean } = {}
): Promise<void> {
  if (!loop) {
    return;
  }

  try {
    await loop.stop();
  } catch (error) {
    if (!options.swallowErrors) {
      throw error;
    }
  }
}

async function stopJobCancellationWatchLoop(
  loop: JobCancellationWatchLoop | undefined,
  options: { swallowErrors?: boolean } = {}
): Promise<void> {
  if (!loop) {
    return;
  }

  try {
    await loop.stop();
  } catch (error) {
    if (!options.swallowErrors) {
      throw error;
    }
  }
}

function normalizeJobLeaseRenewalInterval(intervalMs: number): number {
  return Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : DEFAULT_JOB_LEASE_RENEWAL_INTERVAL_MS;
}

function normalizeJobCancellationPollInterval(intervalMs: number): number {
  return Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.floor(intervalMs)
    : DEFAULT_JOB_CANCELLATION_POLL_INTERVAL_MS;
}

function throwIfJobCancellationRequested(loop: JobCancellationWatchLoop | undefined, jobId: string): void {
  if (loop?.signal.aborted) {
    throw loop.signal.reason instanceof Error ? loop.signal.reason : new Error(`Job cancellation requested: ${jobId}`);
  }
}

interface LocalRunnerFailureClassification {
  errorCategory: NonNullable<WorkflowJobResult["errorCategory"]>;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

function classifyLocalRunnerFailure(error: unknown, fallbackRetryable: boolean): LocalRunnerFailureClassification {
  const errorMessage = redactSecrets(error instanceof Error ? error.message : "Unknown runner engine error");

  if (error instanceof MissingRunnerPackagesError) {
    return {
      errorCategory: "dependency",
      errorCode: error.errorCode,
      errorMessage,
      retryable: error.retryable
    };
  }

  if (error instanceof RunnerResultValidationError) {
    return {
      errorCategory: "result_contract",
      errorCode: "runner_result_invalid",
      errorMessage,
      retryable: false
    };
  }

  if (error instanceof Error && isWorkspaceFailure(error.message)) {
    return {
      errorCategory: "workspace",
      errorCode: "runner_workspace_error",
      errorMessage,
      retryable: fallbackRetryable
    };
  }

  if (error instanceof Error && isCancellationFailure(error.message)) {
    return {
      errorCategory: "cancellation",
      errorCode: "runner_canceled",
      errorMessage,
      retryable: false
    };
  }

  if (error instanceof Error && isGitHubFailure(error.message)) {
    return {
      errorCategory: "github",
      errorCode: "runner_github_error",
      errorMessage,
      retryable: fallbackRetryable
    };
  }

  return {
    errorCategory: "engine",
    errorCode: "runner_engine_error",
    errorMessage,
    retryable: fallbackRetryable
  };
}

function isWorkspaceFailure(message: string): boolean {
  return (
    message.includes("runner workspace") ||
    message.includes("workspaceDir") ||
    message.includes("workdir") ||
    message.includes("git workspace") ||
    message.includes("Generated artifact") ||
    message.includes("Generated file path")
  );
}

function isCancellationFailure(message: string): boolean {
  return message.includes("Job cancellation requested:") || message.includes("canceled");
}

function isGitHubFailure(message: string): boolean {
  return message.includes("GitHub") || message.includes("pull request") || message.includes("PR branch");
}
