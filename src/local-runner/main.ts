import "dotenv/config";
import { GitHubRestClient } from "../integrations/github-client";
import { githubRuntimeConfig } from "../runtime/create-runtime";
import type { RunnerMode } from "../workflow-core/domain";
import {
  GitHubImplementationLocalRunnerEngine,
  ImplementationPullRequestLocalRunnerEngine,
  ImplementationUpdateLocalRunnerEngine,
  RoutedLocalRunnerEngine,
  isGitHubImplementationJobType
} from "./github-implementation-engine";
import { JobTemplateCliLocalRunnerEngine } from "./cli-engine-adapter";
import { runLocalRunnerDrain, runLocalRunnerOnce } from "./local-runner";
import { WorkflowApiRunnerClient } from "./runner-client";

async function main(): Promise<void> {
  const selectedEngine = parseRunnerEngine(process.env.RUNNER_ENGINE);
  const client = new WorkflowApiRunnerClient({
    baseUrl: requireEnv("WORKFLOW_API_BASE_URL"),
    token: process.env.LOCAL_RUNNER_TOKEN
  });
  const cliEngine = new JobTemplateCliLocalRunnerEngine({
    env: process.env,
    outputLanguage: process.env.RUNNER_OUTPUT_LANGUAGE ?? "ko"
  });
  const githubConfig = githubRuntimeConfig(process.env);
  const githubRestClient = githubConfig ? new GitHubRestClient(githubConfig) : undefined;
  const githubImplementationEngine =
    githubConfig && githubRestClient
      ? new GitHubImplementationLocalRunnerEngine({
          client: githubRestClient,
          owner: githubConfig.owner,
          repo: githubConfig.repo,
          defaultBaseBranch: githubConfig.defaultBaseBranch
        })
      : undefined;
  const implementationPullRequestEngine =
    githubConfig && githubRestClient
      ? new ImplementationPullRequestLocalRunnerEngine({
          client: githubRestClient,
          cliEngine,
          owner: githubConfig.owner,
          repo: githubConfig.repo,
          repositoryCloneUrl: optionalEnv("GITHUB_CLONE_URL"),
          defaultBaseBranch: githubConfig.defaultBaseBranch
        })
      : undefined;
  const implementationUpdateEngine = new ImplementationUpdateLocalRunnerEngine({ cliEngine });
  const engine = githubConfig
    ? new RoutedLocalRunnerEngine(
        [
          {
            canRun: (input) => implementationPullRequestEngine!.canRun(input),
            engine: implementationPullRequestEngine!
          },
          {
            canRun: (input) => implementationUpdateEngine.canRun(input),
            engine: implementationUpdateEngine
          },
          {
            canRun: (input) => isGitHubImplementationJobType(input.job.jobType),
            engine: githubImplementationEngine!
          }
        ],
        cliEngine
      )
    : cliEngine;
  const mode = parseRunnerMode(process.env.LOCAL_RUNNER_MODE);
  const ownerUserId = optionalEnv("LOCAL_RUNNER_OWNER_EMAIL", "LOCAL_RUNNER_OWNER_USER_ID");

  if (mode === "local" && !ownerUserId) {
    throw new Error("LOCAL_RUNNER_OWNER_EMAIL is required for local runner mode");
  }

  const runner = {
    id: requireEnv("LOCAL_RUNNER_ID"),
    ownerUserId,
    mode,
    teamIds: parseList(process.env.LOCAL_RUNNER_TEAM_IDS),
    allowedProjectIds: parseList(process.env.LOCAL_RUNNER_ALLOWED_PROJECT_IDS),
    allowedRepositoryIds: parseList(process.env.LOCAL_RUNNER_ALLOWED_REPOSITORY_IDS),
    capabilities: parseList(process.env.LOCAL_RUNNER_CAPABILITIES),
    engines: parseList(process.env.LOCAL_RUNNER_ENGINES, [selectedEngine]),
    defaultEngine: selectedEngine,
    concurrency: parsePositiveInteger(process.env.LOCAL_RUNNER_CONCURRENCY, 1),
    retryableEngineErrors: process.env.LOCAL_RUNNER_RETRYABLE_ENGINE_ERRORS !== "false"
  };

  if (process.env.LOCAL_RUNNER_ONCE === "true") {
    const result = await runLocalRunnerOnce({ client, engine, runner, workspace: createWorkspaceOptions() });
    console.log(JSON.stringify(summarizeResult(result)));
    return;
  }

  const maxJobs = parseOptionalPositiveInteger(process.env.LOCAL_RUNNER_MAX_JOBS, "LOCAL_RUNNER_MAX_JOBS");

  if (maxJobs !== undefined) {
    const result = await runLocalRunnerDrain({
      client,
      engine,
      runner,
      workspace: createWorkspaceOptions(),
      maxJobs
    });
    console.log(JSON.stringify(summarizeDrainResult(result)));
    return;
  }

  const intervalMs = parsePositiveInteger(process.env.LOCAL_RUNNER_POLL_INTERVAL_MS, 5000);

  for (;;) {
    const result = await runLocalRunnerOnce({ client, engine, runner, workspace: createWorkspaceOptions() });
    console.log(JSON.stringify(summarizeResult(result)));
    await delay(intervalMs);
  }
}

function createWorkspaceOptions(): { rootDir: string; clean: boolean } | undefined {
  const rootDir = process.env.LOCAL_RUNNER_WORKSPACE_ROOT;

  if (!rootDir) {
    return undefined;
  }

  return {
    rootDir,
    clean: process.env.LOCAL_RUNNER_CLEAN_WORKSPACE !== "false"
  };
}

function summarizeResult(result: Awaited<ReturnType<typeof runLocalRunnerOnce>>): Record<string, unknown> {
  if (result.status === "idle") {
    return {
      status: result.status,
      runnerId: result.runner.id,
      claimReason: result.diagnostics?.reason,
      claimMessage: result.diagnostics?.message,
      nearestBlocker: result.diagnostics?.nearestBlocker
    };
  }

  return {
    status: result.status,
    runnerId: result.runner.id,
    jobId: result.job.id,
    jobType: result.job.jobType,
    resultStatus: result.result.status,
    errorCode: result.result.errorCode
  };
}

function summarizeDrainResult(result: Awaited<ReturnType<typeof runLocalRunnerDrain>>): Record<string, unknown> {
  return {
    status: "drain_completed",
    stoppedReason: result.stoppedReason,
    processedJobs: result.processedJobs,
    attempts: result.attempts,
    results: result.results.map(summarizeResult)
  };
}

function parseRunnerMode(value: string | undefined): RunnerMode {
  if (!value || value === "local") {
    return "local";
  }

  if (value === "managed") {
    return "managed";
  }

  throw new Error(`LOCAL_RUNNER_MODE must be "local" or "managed", got: ${value}`);
}

function parseRunnerEngine(value: string | undefined): "claude" | "codex" {
  if (!value || value === "claude") {
    return "claude";
  }

  if (value === "codex") {
    return "codex";
  }

  throw new Error(`RUNNER_ENGINE must be "claude" or "codex", got: ${value}`);
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, key: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer, got: ${value}`);
  }

  return parsed;
}

function requireEnv(key: string): string {
  const value = process.env[key];

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function optionalEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
