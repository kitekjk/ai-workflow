import type { Runner, RunnerClaimDiagnostics, WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import { redactSecrets } from "../runtime/secrets";
import type { RegisterRunnerInput } from "../workflow-core/scheduler";
import { validateLocalRunnerEngineResult } from "./result-schema";
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

export interface LocalRunnerConfig extends Omit<RegisterRunnerInput, "now"> {
  retryableEngineErrors?: boolean;
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
  const now = input.now ?? new Date();
  const { retryableEngineErrors, ...runnerRegistration } = input.runner;
  const runner = await input.client.registerRunner({
    ...runnerRegistration,
    now
  });
  await input.client.heartbeat(runner.id, now);

  const claimResponse = await input.client.claimWithDiagnostics(runner.id, now);
  const claim = claimResponse.claim ?? undefined;

  if (!claim) {
    return { status: "idle", runner, diagnostics: claimResponse.diagnostics };
  }

  const { job } = claim;
  let workspace: PreparedJobWorkspace | undefined;

  try {
    workspace = input.workspace ? await prepareJobWorkspace({ job, workspace: input.workspace }) : undefined;
    await input.client.startJob(job.id, runner.id, now);
    await input.client.recordLog({
      jobId: job.id,
      runnerId: runner.id,
      level: "info",
      message: "Job started",
      metadata: {
        jobType: job.jobType,
        workspaceDir: workspace?.workspaceDir
      },
      now
    });

    const engineResult = validateLocalRunnerEngineResult(
      await input.engine.run({
        runner,
        job,
        workspaceDir: workspace?.workspaceDir
      })
    );

    for (const log of engineResult.logs ?? []) {
      await input.client.recordLog({
        jobId: job.id,
        runnerId: runner.id,
        level: log.level,
        message: log.message,
        metadata: log.metadata,
        now
      });
    }

    const jobAfterEngine = await input.client.getJob(job.id);

    if (jobAfterEngine.status === "cancel_requested") {
      const result = await input.client.acknowledgeCancellation({
        jobId: job.id,
        runnerId: runner.id,
        output: {
          status: "canceled"
        },
        now
      });

      return {
        status: "canceled",
        runner,
        job: jobAfterEngine,
        result
      };
    }

    const collectedArtifacts =
      workspace && engineResult.generatedFiles
        ? await collectGeneratedFileArtifacts({
            workspaceDir: workspace.workspaceDir,
            files: engineResult.generatedFiles
          })
        : [];

    for (const artifact of [...(engineResult.artifacts ?? []), ...collectedArtifacts]) {
      await input.client.uploadArtifact({
        jobId: job.id,
        runnerId: runner.id,
        artifact,
        now
      });
    }

    const result = await input.client.completeJob({
      jobId: job.id,
      runnerId: runner.id,
      output: engineResult.output,
      now
    });

    return {
      status: "completed",
      runner,
      job,
      result
    };
  } catch (error) {
    const jobAfterError = await input.client.getJob(job.id).catch(() => undefined);

    if (jobAfterError?.status === "cancel_requested") {
      const result = await input.client.acknowledgeCancellation({
        jobId: job.id,
        runnerId: runner.id,
        output: {
          status: "canceled"
        },
        now
      });

      return {
        status: "canceled",
        runner,
        job: jobAfterError,
        result
      };
    }

    const result = await input.client.failJob({
      jobId: job.id,
      runnerId: runner.id,
      output: {
        status: "failed"
      },
      errorCode: "runner_engine_error",
      errorMessage: redactSecrets(error instanceof Error ? error.message : "Unknown runner engine error"),
      retryable: retryableEngineErrors ?? true,
      now
    });

    return {
      status: "failed",
      runner,
      job,
      result
    };
  }
}
