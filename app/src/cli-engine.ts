// app/src/cli-engine.ts
export interface EngineConfig {
  cliPath: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
  workspaceBase: string;
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    cliPath: env.CLAUDE_CLI_PATH ?? "claude",
    timeoutMs: Number(env.SKILL_TIMEOUT_MS ?? "120000"),
    model: env.SKILL_MODEL,
    maxTurns: env.SKILL_MAX_TURNS ? Number(env.SKILL_MAX_TURNS) : undefined,
    workspaceBase: env.SKILL_WORKSPACE_BASE ?? ".workspaces",
  };
}
