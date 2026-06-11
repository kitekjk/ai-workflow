// app/src/cli-engine.ts
import type { JobType } from "./domain";

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

export interface SkillInput {
  jobId: string;
  inlineInputs: Record<string, unknown>;
  inputRefs: { system: string; key: string; url?: string; label?: string }[];
}

export function buildWrapperPrompt(
  skill: string,
  jobType: JobType,
  input: SkillInput,
  outputSchema: Record<string, unknown>,
): string {
  const inputs = { inlineInputs: input.inlineInputs, inputRefs: input.inputRefs };
  return [
    `Use the \`${skill}\` skill to perform the "${jobType}" job.`,
    ``,
    `Job inputs (JSON):`,
    JSON.stringify(inputs, null, 2),
    ``,
    `When finished, write ONLY the result envelope as JSON to the file ./out/envelope.json`,
    `relative to your current working directory. Do not print the envelope to stdout.`,
    `The envelope MUST have exactly this shape:`,
    `{`,
    `  "domainOutput": <object matching the JSON Schema below>,`,
    `  "refs": [ { "system": string, "key": string, "url"?: string, "label"?: string } ],`,
    `  "nextTaskCandidates"?: string[]`,
    `}`,
    ``,
    `domainOutput JSON Schema:`,
    JSON.stringify(outputSchema, null, 2),
  ].join("\n");
}
