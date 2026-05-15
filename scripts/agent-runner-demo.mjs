#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

function parseArgs(argv) {
  const args = {
    skill: "prd.simple",
    claudeBin: "claude",
    maxTurns: "3",
    timeoutMs: 120000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if ((arg === "--requirement" || arg === "-r") && next) {
      args.requirement = next;
      i += 1;
    } else if ((arg === "--input" || arg === "-i") && next) {
      args.input = next;
      i += 1;
    } else if ((arg === "--out" || arg === "-o") && next) {
      args.out = next;
      i += 1;
    } else if (arg === "--skill" && next) {
      args.skill = next;
      i += 1;
    } else if (arg === "--model" && next) {
      args.model = next;
      i += 1;
    } else if (arg === "--claude-bin" && next) {
      args.claudeBin = next;
      i += 1;
    } else if (arg === "--max-turns" && next) {
      args.maxTurns = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      args.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    '  node scripts/agent-runner-demo.mjs --requirement "간단한 요구사항"',
    "  node scripts/agent-runner-demo.mjs --input requirements.txt --out output/prd.md",
    "",
    "Options:",
    "  -r, --requirement   Requirement text.",
    "  -i, --input         Path to a text file containing the requirement.",
    "  -o, --out           Optional path to copy the generated PRD markdown.",
    "      --skill         Skill id under skills/. Default: prd.simple",
    "      --model         Optional Claude model alias/name, e.g. sonnet",
    "      --claude-bin    Claude CLI binary. Default: claude",
    "      --max-turns     Claude Code max turns. Default: 3",
    "      --timeout-ms    Runner timeout. Default: 120000",
  ].join("\n");
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function appendEvent(runDir, event) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
  await writeFile(path.join(runDir, "events.ndjson"), line, { flag: "a" });
}

async function readRequirement(args) {
  if (args.requirement) {
    return args.requirement.trim();
  }

  if (args.input) {
    return (await readFile(path.resolve(repoRoot, args.input), "utf8")).trim();
  }

  throw new Error("Either --requirement or --input is required.");
}

async function loadSkill(skillId) {
  const skillDir = path.join(repoRoot, "skills", skillId);
  const [metadataRaw, prompt] = await Promise.all([
    readFile(path.join(skillDir, "skill.json"), "utf8"),
    readFile(path.join(skillDir, "prompt.md"), "utf8"),
  ]);

  return {
    dir: skillDir,
    metadata: JSON.parse(metadataRaw),
    prompt,
  };
}

function buildRunnerPrompt({ skill, requirement }) {
  return [
    "# Agent Runner Demo",
    "",
    "You are being executed by a local Agent Runner demo.",
    "Follow the selected skill instructions exactly and produce the required output.",
    "",
    "## Selected Skill Metadata",
    "",
    JSON.stringify(skill.metadata, null, 2),
    "",
    "## Selected Skill Instructions",
    "",
    skill.prompt.trim(),
    "",
    "## User Requirement",
    "",
    requirement,
    "",
    "## Output Contract",
    "",
    "Return only the final PRD Markdown document.",
  ].join("\n");
}

function runClaude({ args, prompt, runDir }) {
  return new Promise((resolve, reject) => {
    const claudeArgs = [
      "-p",
      "Create the PRD using the runner prompt provided on stdin. Return only the final Markdown document.",
      "--output-format",
      "text",
      "--max-turns",
      String(args.maxTurns),
    ];

    if (args.model) {
      claudeArgs.push("--model", args.model);
    }

    const child = spawn(args.claudeBin, claudeArgs, {
      cwd: runDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, args.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }

  const requirement = await readRequirement(args);
  const skill = await loadSkill(args.skill);
  const runId = safeTimestamp();
  const runDir = path.join(repoRoot, "runs", "agent-runner-demo", runId);
  const outputDir = path.join(runDir, "outputs");
  await mkdir(outputDir, { recursive: true });

  const runnerPrompt = buildRunnerPrompt({ skill, requirement });

  await writeFile(path.join(runDir, "input.md"), `${requirement}\n`);
  await writeFile(path.join(runDir, "prompt.md"), `${runnerPrompt}\n`);
  await appendEvent(runDir, {
    type: "job.accepted",
    skill: skill.metadata.id,
    skillVersion: skill.metadata.version,
  });

  await appendEvent(runDir, {
    type: "job.started",
    engine: "claude_cli",
    claudeBin: args.claudeBin,
  });

  const startedAt = new Date().toISOString();
  const claudeResult = await runClaude({ args, prompt: runnerPrompt, runDir });
  const finishedAt = new Date().toISOString();

  await writeFile(path.join(runDir, "stdout.log"), claudeResult.stdout);
  await writeFile(path.join(runDir, "stderr.log"), claudeResult.stderr);

  if (claudeResult.code !== 0 || claudeResult.timedOut) {
    await appendEvent(runDir, {
      type: "job.failed",
      exitCode: claudeResult.code,
      signal: claudeResult.signal,
      timedOut: claudeResult.timedOut,
    });

    const message = claudeResult.timedOut
      ? `Claude CLI timed out after ${args.timeoutMs}ms`
      : `Claude CLI failed with exit code ${claudeResult.code}`;
    throw new Error(`${message}. See ${path.join(runDir, "stderr.log")}`);
  }

  const prdPath = path.join(outputDir, "prd.md");
  await writeFile(prdPath, claudeResult.stdout.trimEnd() + "\n");

  const result = {
    status: "completed",
    runId,
    skill: {
      id: skill.metadata.id,
      version: skill.metadata.version,
    },
    engine: {
      type: "claude_cli",
      model: args.model || skill.metadata.engine.defaultModel,
    },
    startedAt,
    finishedAt,
    outputs: {
      prd: path.relative(repoRoot, prdPath),
    },
    logs: {
      stdout: path.relative(repoRoot, path.join(runDir, "stdout.log")),
      stderr: path.relative(repoRoot, path.join(runDir, "stderr.log")),
      events: path.relative(repoRoot, path.join(runDir, "events.ndjson")),
    },
  };

  if (args.out) {
    const outPath = path.resolve(repoRoot, args.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await copyFile(prdPath, outPath);
    result.outputs.copiedTo = path.relative(repoRoot, outPath);
  }

  await writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  await appendEvent(runDir, {
    type: "job.completed",
    output: result.outputs,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
