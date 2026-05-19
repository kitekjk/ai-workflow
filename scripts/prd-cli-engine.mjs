#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const input = JSON.parse(await readStdin());
const prompt = buildPrompt(input);
const result = await runEngine(args, prompt);
const parsed = parseJsonObject(result.stdout);

process.stdout.write(`${JSON.stringify(parsed)}\n`);

function parseArgs(argv) {
  const parsed = {
    engine: "claude",
    bin: "claude",
    timeoutMs: 120000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--engine" && next) {
      parsed.engine = next;
      i += 1;
    } else if (arg === "--bin" && next) {
      parsed.bin = next;
      i += 1;
    } else if (arg === "--model" && next) {
      parsed.model = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      parsed.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--max-turns" && next) {
      parsed.maxTurns = next;
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (parsed.engine !== "claude" && parsed.engine !== "codex") {
    throw new Error(`Unsupported runner engine: ${parsed.engine}`);
  }

  return parsed;
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  return body;
}

async function runEngine(options, prompt) {
  if (options.engine === "codex") {
    return runCodex(options, prompt);
  }

  return runClaude(options, prompt);
}

async function runClaude(options, prompt) {
  const cliArgs = [
    "-p",
    "Execute the PRD workflow task from stdin. Return only the requested JSON object.",
    "--output-format",
    "text",
    "--max-turns",
    String(options.maxTurns ?? 3),
  ];

  if (options.model) {
    cliArgs.push("--model", options.model);
  }

  return runProcess(options.bin, cliArgs, prompt, options.timeoutMs);
}

async function runCodex(options, prompt) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "prd-codex-cli-"));
  const outputFile = path.join(outputDir, "last-message.txt");
  const cliArgs = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputFile,
  ];

  if (options.model) {
    cliArgs.push("--model", options.model);
  }

  cliArgs.push("-");

  try {
    const result = await runProcess(options.bin, cliArgs, prompt, options.timeoutMs);
    const finalMessage = await readFile(outputFile, "utf8").catch(() => result.stdout);
    return { ...result, stdout: finalMessage };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function runProcess(command, cliArgs, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} exited with code ${code}. stderr: ${stderr.trim()}`));
    });

    child.stdin.end(stdin);
  });
}

function buildPrompt(input) {
  const languageInstruction = buildLanguageInstruction(input.outputLanguage);

  if (input.jobType === "prd.evaluate_quality") {
    return [
      `You are evaluating a generated ${input.documentType ?? "document"} for planner approval readiness.`,
      "Evaluate the generated document markdown in currentDocumentMarkdown. Do not treat an empty Jira description as an empty document when currentDocumentMarkdown is present.",
      "Legacy input may also include currentPrdMarkdown; prefer currentDocumentMarkdown when both exist.",
      languageInstruction,
      "Return only a JSON object with this shape:",
      '{"status":"passed|needs_revision","score":0,"summary":"...","missingInformation":[],"clarificationQuestions":[],"riskItems":[]}',
      "",
      "Input context:",
      JSON.stringify(input, null, 2),
    ].join("\n");
  }

  const revisionInstruction =
    input.jobType === "prd.apply_feedback_revision"
      ? "Revise the PRD using the planner feedback included in the input."
      : "Generate an initial PRD from the linked source requests.";

  return [
    `You are generating a ${input.documentType ?? "document"} for an AI workflow system.`,
    revisionInstruction,
    languageInstruction,
    "Return only a JSON object with this shape:",
    '{"status":"succeeded","markdown":"# ...","summary":"...","revisionSummary":"..."}',
    "For initial drafts, omit revisionSummary.",
    "",
    "Input context:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function buildLanguageInstruction(outputLanguage) {
  if (!outputLanguage || outputLanguage === "ko" || outputLanguage.toLowerCase() === "korean") {
    return "Write every human-readable string in Korean, including markdown, summary, missingInformation, clarificationQuestions, and riskItems.";
  }

  return `Write every human-readable string in ${outputLanguage}.`;
}

function parseJsonObject(stdout) {
  const trimmed = stdout.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }

    throw new Error(`Engine output was not JSON: ${trimmed.slice(0, 500)}`);
  }
}
