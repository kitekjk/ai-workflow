// app/src/cli-engine.ts
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { Envelope, JobType } from "./domain";
import type { Skill } from "./stub-skill";
import type { StrategyDef } from "./strategy";
import { prepareJobWorkspace } from "./workspace";

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

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type RunClaude = (
  config: EngineConfig,
  cwd: string,
  prompt: string,
) => Promise<ClaudeResult>;

/** Real spawn of `claude -p ... --output-format json`. F9: capture stdout AND stderr. */
export const runClaude: RunClaude = (config, cwd, prompt) =>
  new Promise<ClaudeResult>((resolve, reject) => {
    // stdout JSON is captured for F9 failure diagnostics only; the envelope itself is
    // returned via the workspace ./out/envelope.json file, not parsed from stdout.
    const args = ["-p", prompt, "--output-format", "json"];
    if (config.model) args.push("--model", config.model);
    if (config.maxTurns) args.push("--max-turns", String(config.maxTurns)); // Claude CLI flag name

    const child = spawn(config.cliPath, args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${config.timeoutMs}ms\nstderr: ${stderr}`));
    }, config.timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });

async function readEnvelopeFile(path: string): Promise<Envelope> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`envelope file not found at ${path}`);
  }
  try {
    return JSON.parse(text) as Envelope;
  } catch (e) {
    throw new Error(`envelope file is not valid JSON: ${String(e)}`);
  }
}

/**
 * Build a Skill backed by the real Claude CLI. Domain work is the installed skill's;
 * this only injects the I/O contract, isolates a workspace (F10), surfaces failures (F9),
 * and reads the envelope file. Shape validation stays in the Runner (validateEnvelope).
 */
export function makeClaudeSkill(
  strategy: StrategyDef,
  config: EngineConfig,
  run: RunClaude = runClaude,
): Skill {
  return async (jobType, input) => {
    const jobDef = strategy.jobs[jobType];
    if (!jobDef) throw new Error(`no jobDef for job type "${jobType}"`);

    const ws = await prepareJobWorkspace(config.workspaceBase, input.jobId);
    try {
      const prompt = buildWrapperPrompt(jobDef.skill, jobType, input, jobDef.outputSchema);
      const { stdout, stderr, code } = await run(config, ws.dir, prompt);
      if (code !== 0) {
        throw new Error(`claude exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      }
      return await readEnvelopeFile(ws.outFile);
    } finally {
      await rm(ws.dir, { recursive: true, force: true });
    }
  };
}
