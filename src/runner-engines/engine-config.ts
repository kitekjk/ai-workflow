import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RunnerEngineName = "claude" | "codex";

export interface CliEngineConfig {
  engine: RunnerEngineName;
  command: string;
  args: string[];
  timeoutMs: number;
}

export function createCliEngineConfig(env: NodeJS.ProcessEnv): CliEngineConfig {
  const engine = parseRunnerEngine(env.RUNNER_ENGINE);
  const pathKey = engine === "claude" ? "CLAUDE_CLI_PATH" : "CODEX_CLI_PATH";
  const command = env[pathKey];
  const childTimeoutMs = parseTimeoutMs(env.RUNNER_CLI_TIMEOUT_MS);

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
      model: env.RUNNER_CLI_MODEL,
      maxTurns: env.RUNNER_CLI_MAX_TURNS
    }),
    timeoutMs: childTimeoutMs + 10000
  };
}

function buildBridgeArgs(options: {
  engine: RunnerEngineName;
  bin: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: string;
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

  return args;
}

function bridgeScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "../../scripts/prd-cli-engine.mjs");
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

function parseTimeoutMs(value: string | undefined): number {
  if (!value) {
    return 120000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`RUNNER_CLI_TIMEOUT_MS must be a positive integer, got: ${value}`);
  }

  return parsed;
}
