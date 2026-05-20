import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runner, WorkflowJob } from "../workflow-core/domain";

export type RunnerEngineName = "claude" | "codex";
export type RunnerCliSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CliEngineConfig {
  engine: RunnerEngineName;
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
}

export interface CreateCliEngineConfigContext {
  job?: Pick<WorkflowJob, "input" | "preferredEngine" | "requiredEngine">;
  runner?: Pick<Runner, "defaultEngine" | "engines">;
  workspaceDir?: string;
}

export interface RunnerJobTemplateCliConfig {
  engine?: RunnerEngineName;
  command?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: string;
  sandbox?: RunnerCliSandbox;
  workdir?: string;
}

export function createCliEngineConfig(
  env: NodeJS.ProcessEnv,
  context: CreateCliEngineConfigContext = {}
): CliEngineConfig {
  const template = readRunnerJobTemplateCliConfig(context.job?.input);
  const engine = selectRunnerEngine(env, template, context);
  const pathKey = engine === "claude" ? "CLAUDE_CLI_PATH" : "CODEX_CLI_PATH";
  const command = template.command ?? env[pathKey];
  const childTimeoutMs = template.timeoutMs ?? parseTimeoutMs(env.RUNNER_CLI_TIMEOUT_MS, "RUNNER_CLI_TIMEOUT_MS");
  const cwd = resolveTemplateWorkdir(template.workdir, context.workspaceDir);
  const sandbox = template.sandbox ?? parseOptionalSandbox(env.RUNNER_CLI_SANDBOX, "RUNNER_CLI_SANDBOX");

  if (!command) {
    throw new Error(`${pathKey} is required when RUNNER_SKILL_MODE=cli`);
  }

  return {
    engine,
    command: process.execPath,
    args: buildBridgeArgs({
      engine,
      bin: command,
      timeoutMs: childTimeoutMs,
      model: template.model ?? env.RUNNER_CLI_MODEL,
      maxTurns: template.maxTurns ?? env.RUNNER_CLI_MAX_TURNS,
      sandbox,
      workdir: cwd
    }),
    timeoutMs: childTimeoutMs + 10000,
    cwd
  };
}

function buildBridgeArgs(options: {
  engine: RunnerEngineName;
  bin: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: string;
  sandbox?: RunnerCliSandbox;
  workdir?: string;
}): string[] {
  const args = [
    bridgeScriptPath(),
    "--engine",
    options.engine,
    "--bin",
    options.bin,
    "--timeout-ms",
    String(options.timeoutMs)
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.maxTurns) {
    args.push("--max-turns", options.maxTurns);
  }

  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }

  if (options.workdir) {
    args.push("--workdir", options.workdir);
  }

  return args;
}

function bridgeScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "../../scripts/document-runner-engine.mjs");
}

function selectRunnerEngine(
  env: NodeJS.ProcessEnv,
  template: RunnerJobTemplateCliConfig,
  context: CreateCliEngineConfigContext
): RunnerEngineName {
  const requiredEngine = parseOptionalRunnerEngine(context.job?.requiredEngine, "job.requiredEngine");
  const preferredEngine = parseOptionalRunnerEngine(context.job?.preferredEngine, "job.preferredEngine");

  if (requiredEngine && template.engine && requiredEngine !== template.engine) {
    throw new Error(
      `runnerJobTemplate.engine (${template.engine}) must match job.requiredEngine (${requiredEngine})`
    );
  }

  const engine =
    requiredEngine ??
    template.engine ??
    preferredEngine ??
    parseOptionalRunnerEngine(context.runner?.defaultEngine, "runner.defaultEngine") ??
    parseRunnerEngine(env.RUNNER_ENGINE);

  if (context.runner?.engines.length && !context.runner.engines.includes(engine)) {
    throw new Error(`Selected runner engine "${engine}" is not available on runner`);
  }

  return engine;
}

function parseRunnerEngine(value: string | undefined): RunnerEngineName {
  if (!value || value === "claude") {
    return "claude";
  }

  if (value === "codex") {
    return "codex";
  }

  throw new Error(`RUNNER_ENGINE must be "claude" or "codex", got: ${value}`);
}

function parseOptionalRunnerEngine(value: string | undefined, label: string): RunnerEngineName | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "claude" || value === "codex") {
    return value;
  }

  throw new Error(`${label} must be "claude" or "codex", got: ${value}`);
}

function readRunnerJobTemplateCliConfig(input: Record<string, unknown> | undefined): RunnerJobTemplateCliConfig {
  const rawTemplate = firstRecord(input?.runnerJobTemplate, input?.jobTemplate);
  const rawConfig = firstRecord(rawTemplate?.runner, rawTemplate?.cli, rawTemplate);

  if (!rawConfig) {
    return {};
  }

  return {
    engine: parseOptionalRunnerEngine(optionalString(rawConfig.engine), "runnerJobTemplate.engine"),
    command: optionalString(rawConfig.command) ?? optionalString(rawConfig.bin),
    model: optionalString(rawConfig.model),
    timeoutMs: parseOptionalPositiveInteger(rawConfig.timeoutMs, "runnerJobTemplate.timeoutMs"),
    maxTurns: optionalStringOrNumber(rawConfig.maxTurns),
    sandbox: parseOptionalSandbox(optionalString(rawConfig.sandbox), "runnerJobTemplate.sandbox"),
    workdir: optionalString(rawConfig.workdir) ?? optionalString(rawConfig.cwd)
  };
}

function parseTimeoutMs(value: string | undefined, label: string): number {
  if (!value) {
    return 120000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got: ${String(value)}`);
  }

  return parsed;
}

function parseOptionalSandbox(value: string | undefined, label: string): RunnerCliSandbox | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }

  throw new Error(`${label} must be "read-only", "workspace-write", or "danger-full-access", got: ${value}`);
}

function resolveTemplateWorkdir(workdir: string | undefined, workspaceDir: string | undefined): string | undefined {
  const workspaceRoot = workspaceDir ? resolve(workspaceDir) : undefined;

  if (!workdir) {
    return workspaceRoot;
  }

  const resolved = workspaceRoot && !isAbsolute(workdir) ? resolve(workspaceRoot, workdir) : resolve(workdir);

  if (workspaceRoot && !isPathInside(workspaceRoot, resolved)) {
    throw new Error(`runnerJobTemplate.workdir must stay inside runner workspace: ${workdir}`);
  }

  return resolved;
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const path = relative(rootDir, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringOrNumber(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}
