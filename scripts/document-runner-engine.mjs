#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const input = JSON.parse(await readStdin());
  const prompt = buildPrompt(input);
  const result = await runEngine(args, prompt);
  const parsed = parseJsonObject(result.stdout);

  // Normalize prd.route_downstream success status to "route_decided" so the
  // upcoming definition-driven interpreter can distinguish the success path
  // from needs_scope_confirmation through result.status.
  const jobType = String(input.jobType ?? "document.generate");
  if (jobType === "prd.route_downstream") {
    const currentStatus = parsed?.status;
    if (currentStatus !== "needs_scope_confirmation" && currentStatus !== "failed") {
      parsed.status = "route_decided";
    }
  }

  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}

export function buildPrompt(input) {
  const languageInstruction = buildLanguageInstruction(input.outputLanguage);
  const documentType = input.documentType ?? inferDocumentType(input);
  const jobType = String(input.jobType ?? "document.generate");
  const promptContract = input.promptContract ?? buildPromptContract({ jobType, documentType });
  const contractBlock = buildContractBlock(promptContract);

  if (isImplementationOpenPrJob(jobType)) {
    const skillBlock = buildSkillBlock(runnerSkillIdFor(input, "implementation.pr-author"));

    return [
      "You are implementing an approved Spec and preparing its first pull request for an AI workflow system.",
      "The target repository branch has been checked out in the current working directory when repositoryCloneUrl and branchName are present.",
      "Use the approved Spec artifact, branch metadata, and input context to make the smallest complete implementation for this PR.",
      languageInstruction,
      skillBlock,
      contractBlock,
      "Return only a JSON object with this shape:",
      '{"status":"implemented","latestCommitSha":"...","summary":"...","pullRequestTitle":"...","pullRequestBody":"...","artifacts":[],"generatedFiles":[]}',
      "Omit artifacts or generatedFiles unless the job explicitly asks for file outputs.",
      "",
      "Input context:",
      JSON.stringify(input, null, 2),
    ].join("\n");
  }

  if (isImplementationUpdateJob(jobType)) {
    const skillBlock = buildSkillBlock(runnerSkillIdFor(input, "implementation.pr-updater"));

    return [
      "You are updating an existing implementation pull request for an AI workflow system.",
      "The PR branch has already been checked out in the current working directory when repositoryCloneUrl and branchName are present.",
      "Use the feedback, failing checks, current document version, and PR metadata from the input context to make the smallest correct code change.",
      languageInstruction,
      skillBlock,
      contractBlock,
      "Return only a JSON object with this shape:",
      '{"status":"succeeded","pullRequestNumber":1,"pullRequestUrl":"https://...","latestCommitSha":"...","summary":"...","artifacts":[],"generatedFiles":[]}',
      "Omit artifacts or generatedFiles unless the job explicitly asks for file outputs.",
      "",
      "Input context:",
      JSON.stringify(input, null, 2),
    ].join("\n");
  }

  if (isEvaluationJob(jobType)) {
    return [
      `You are evaluating a generated ${documentType} for approval readiness.`,
      "Evaluate the generated document markdown in currentDocumentMarkdown. Do not treat an empty source description as an empty document when currentDocumentMarkdown is present.",
      "Legacy input may also include currentPrdMarkdown; prefer currentDocumentMarkdown when both exist.",
      languageInstruction,
      contractBlock,
      "Return only a JSON object with this shape:",
      '{"status":"passed|needs_revision","score":0,"summary":"...","missingInformation":[],"clarificationQuestions":[],"riskItems":[]}',
      "",
      "Input context:",
      JSON.stringify(input, null, 2),
    ].join("\n");
  }

  if (isPlanningJob(jobType)) {
    return [
      `You are planning downstream workflow documents from an approved ${documentType}.`,
      "Choose only downstream documents that are justified by the input context and the prompt contract.",
      languageInstruction,
      contractBlock,
      "Return only a JSON object matching the Output JSON Schema. Include downstreamDocuments with type and title.",
      "",
      "Input context:",
      JSON.stringify(input, null, 2),
    ].join("\n");
  }

  const revisionInstruction = isRevisionJob(jobType)
    ? `Revise the ${documentType} using the feedback included in the input.`
    : `Generate an initial ${documentType} from the linked source context.`;

  return [
    `You are generating a ${documentType} for an AI workflow system.`,
    revisionInstruction,
    languageInstruction,
    contractBlock,
    "Return only a JSON object with this shape:",
    '{"status":"succeeded","markdown":"# ...","summary":"...","revisionSummary":"...","artifacts":[],"generatedFiles":[]}',
    "For initial drafts, omit revisionSummary. Include artifacts or generatedFiles only when the job explicitly asks you to produce file outputs.",
    "",
    "Input context:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function buildSkillBlock(skillId) {
  const skillDir = path.join(repoRoot, "skills", skillId);
  const metadataPath = path.join(skillDir, "skill.json");
  const promptPath = path.join(skillDir, "prompt.md");

  if (!existsSync(metadataPath) || !existsSync(promptPath)) {
    throw new Error(`Runner skill package ${skillId} is not installed under ${skillDir}`);
  }

  return [
    "## Runner Skill Package",
    "",
    readFileSync(metadataPath, "utf8").trim(),
    "",
    "## Runner Skill Instructions",
    "",
    readFileSync(promptPath, "utf8").trim(),
  ].join("\n");
}

function runnerSkillIdFor(input, fallback) {
  const runnerSkill = input && typeof input.runnerSkill === "object" && !Array.isArray(input.runnerSkill)
    ? input.runnerSkill
    : undefined;

  return typeof runnerSkill?.id === "string" && runnerSkill.id.length > 0 ? runnerSkill.id : fallback;
}

function parseArgs(argv) {
  const parsed = {
    engine: "claude",
    bin: "claude",
    timeoutMs: 120000,
    sandbox: "read-only",
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
    } else if (arg === "--sandbox" && next) {
      parsed.sandbox = next;
      i += 1;
    } else if (arg === "--workdir" && next) {
      parsed.workdir = next;
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (parsed.engine !== "claude" && parsed.engine !== "codex") {
    throw new Error(`Unsupported runner engine: ${parsed.engine}`);
  }

  if (
    parsed.sandbox !== "read-only" &&
    parsed.sandbox !== "workspace-write" &&
    parsed.sandbox !== "danger-full-access"
  ) {
    throw new Error(`Unsupported Codex sandbox: ${parsed.sandbox}`);
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
    "Execute the document workflow task from stdin. Return only the requested JSON object.",
    "--output-format",
    "text",
    "--max-turns",
    String(options.maxTurns ?? 3),
  ];

  if (options.model) {
    cliArgs.push("--model", options.model);
  }

  return runProcess(options.bin, cliArgs, prompt, options.timeoutMs, options.workdir);
}

async function runCodex(options, prompt) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "document-codex-cli-"));
  const outputFile = path.join(outputDir, "last-message.txt");
  const cliArgs = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    options.sandbox ?? "read-only",
    "--output-last-message",
    outputFile,
  ];

  if (options.model) {
    cliArgs.push("--model", options.model);
  }

  cliArgs.push("-");

  try {
    const result = await runProcess(options.bin, cliArgs, prompt, options.timeoutMs, options.workdir);
    const finalMessage = await readFile(outputFile, "utf8").catch(() => result.stdout);
    return { ...result, stdout: finalMessage };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function runProcess(command, cliArgs, stdin, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const spawnCommand = resolveSpawnCommand(command, cliArgs);
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd,
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

function resolveSpawnCommand(command, args) {
  if (process.platform !== "win32" || !existsSync(command)) {
    return { command, args };
  }

  const firstLine = readFileSync(command, "utf8").split(/\r?\n/, 1)[0] ?? "";

  if (!firstLine.startsWith("#!") || !firstLine.includes("node")) {
    return { command, args };
  }

  return {
    command: process.execPath,
    args: [command, ...args],
  };
}

function inferDocumentType(input) {
  const jobType = String(input.jobType ?? "");

  if (jobType.startsWith("prd.")) {
    return "prd";
  }

  return "document";
}

function buildPromptContract(input) {
  const documentType = normalizeDocumentType(input.documentType);
  const base = promptContractForDocumentType(documentType);

  return {
    ...base,
    jobType: String(input.jobType ?? "document.generate"),
    outputSchema: outputSchemaForJob(String(input.jobType ?? "document.generate"), documentType, base.downstreamTarget),
  };
}

function buildContractBlock(contract) {
  return [
    "Prompt contract:",
    JSON.stringify(contract, null, 2),
    "Required markdown sections:",
    JSON.stringify(contract.requiredMarkdownSections ?? [], null, 2),
    "Output JSON Schema:",
    JSON.stringify(contract.outputSchema ?? {}, null, 2),
  ].join("\n");
}

function normalizeDocumentType(value) {
  return ["prd", "hld", "lld", "adr", "spec"].includes(value) ? value : "document";
}

function promptContractForDocumentType(documentType) {
  const common = {
    version: "document-contract-v1",
    documentType,
  };

  if (documentType === "hld") {
    return {
      ...common,
      displayName: "High-Level Design",
      generationGoal: "Translate an approved PRD into architecture boundaries and downstream LLD candidates.",
      requiredMarkdownSections: [
        "Architecture Context",
        "System Boundaries",
        "Major Components",
        "Data Flow",
        "External Integrations",
        "Operational Risks",
        "LLD Fan-out Recommendation",
      ],
      evaluationRubric: [
        "Boundaries and ownership are clear.",
        "Component responsibilities are separated.",
        "LLD fan-out units are small enough for detailed design.",
      ],
      downstreamTarget: "lld",
    };
  }

  if (documentType === "lld") {
    return {
      ...common,
      displayName: "Low-Level Design",
      generationGoal: "Turn an HLD area into implementation-ready design detail and Spec candidates.",
      requiredMarkdownSections: [
        "Scope",
        "Use Cases",
        "API Contract",
        "Data Model",
        "Failure Handling",
        "Security and Permissions",
        "Test Strategy",
        "Rollout and Rollback",
        "Spec Fan-out Recommendation",
      ],
      evaluationRubric: [
        "APIs, data changes, and failure behavior are explicit.",
        "Security and permission impacts are covered.",
        "Spec fan-out units are PR-sized and independently verifiable.",
      ],
      downstreamTarget: "spec",
    };
  }

  if (documentType === "adr") {
    return {
      ...common,
      displayName: "Architecture Decision Record",
      generationGoal: "Record a significant technical decision with context, alternatives, and consequences.",
      requiredMarkdownSections: ["Status", "Context", "Decision", "Alternatives Considered", "Consequences"],
      evaluationRubric: [
        "The decision is stated unambiguously.",
        "Alternatives and tradeoffs are documented.",
        "Consequences are actionable for future maintainers.",
      ],
    };
  }

  if (documentType === "spec") {
    return {
      ...common,
      displayName: "Implementation Spec",
      generationGoal: "Create a PR-sized implementation specification ready for code or human execution.",
      requiredMarkdownSections: [
        "Task Scope",
        "Implementation Plan",
        "Interfaces and Files",
        "Test Plan",
        "Acceptance Criteria",
        "Rollback Plan",
      ],
      evaluationRubric: [
        "The task can be implemented in one focused PR.",
        "Files, interfaces, and tests are concrete.",
        "Acceptance criteria are directly verifiable.",
      ],
    };
  }

  return {
    ...common,
    documentType: documentType === "document" ? "prd" : documentType,
    displayName: "Product Requirements Document",
    generationGoal: "Convert linked source requests into a planner-reviewable product requirements document.",
    requiredMarkdownSections: [
      "Overview",
      "Problem Statement",
      "Goals and Non-Goals",
      "Users and Use Cases",
      "Functional Requirements",
      "Success Metrics",
      "Acceptance Criteria",
      "Open Questions",
    ],
    evaluationRubric: [
      "The problem and target users are explicit.",
      "Functional requirements are testable.",
      "Success metrics are measurable.",
      "Acceptance criteria are specific enough for downstream design.",
    ],
    downstreamTarget: "hld",
  };
}

function outputSchemaForJob(jobType, documentType, downstreamTarget) {
  if (isEvaluationJob(jobType)) {
    return {
      type: "object",
      required: ["status", "score", "summary", "missingInformation", "clarificationQuestions", "riskItems"],
      properties: {
        status: { type: "string", enum: ["passed", "needs_revision"] },
        score: { type: "number", minimum: 0, maximum: 100 },
        summary: { type: "string" },
        missingInformation: { type: "array", items: { type: "string" } },
        clarificationQuestions: { type: "array", items: { type: "string" } },
        riskItems: { type: "array", items: { type: "string" } },
      },
    };
  }

  if (jobType === "prd.route_downstream" || jobType === "document.fan_out") {
    const targetTypes = downstreamTarget ? [downstreamTarget] : ["hld", "lld", "spec"];

    return {
      type: "object",
      required: ["status", "rationale", "downstreamDocuments"],
      properties: {
        status: { type: "string", enum: jobType === "document.fan_out" ? ["fanout_ready", "needs_scope_confirmation"] : ["routed", "needs_scope_confirmation"] },
        route: { type: "string", enum: ["hld", "lld", "spec"] },
        targetDocumentType: { type: "string", enum: targetTypes },
        rationale: { type: "string" },
        downstreamDocuments: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "title"],
            properties: {
              type: { type: "string", enum: targetTypes },
              title: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
      },
    };
  }

  if (isImplementationOpenPrJob(jobType)) {
    return {
      type: "object",
      required: ["status", "summary", "pullRequestTitle", "pullRequestBody"],
      properties: {
        status: { type: "string", enum: ["implemented", "succeeded"] },
        latestCommitSha: { type: "string" },
        summary: { type: "string" },
        pullRequestTitle: { type: "string" },
        pullRequestBody: { type: "string" },
        artifacts: { type: "array", items: { type: "object" } },
        generatedFiles: { type: "array", items: { type: "object" } },
      },
    };
  }

  if (isImplementationUpdateJob(jobType)) {
    return {
      type: "object",
      required: ["status", "pullRequestNumber", "pullRequestUrl", "summary"],
      properties: {
        status: { type: "string", enum: ["succeeded"] },
        pullRequestNumber: { type: "integer", minimum: 1 },
        pullRequestUrl: { type: "string" },
        latestCommitSha: { type: "string" },
        summary: { type: "string" },
        artifacts: { type: "array", items: { type: "object" } },
        generatedFiles: { type: "array", items: { type: "object" } },
      },
    };
  }

  return {
    type: "object",
    required: isRevisionJob(jobType) ? ["status", "markdown", "summary", "revisionSummary"] : ["status", "markdown", "summary"],
    properties: {
      status: { type: "string", enum: ["succeeded"] },
      markdown: { type: "string" },
      summary: { type: "string" },
      revisionSummary: { type: "string" },
      artifacts: { type: "array", items: { type: "object" } },
      generatedFiles: { type: "array", items: { type: "object" } },
      documentType: { type: "string", enum: [documentType] },
    },
  };
}

function isEvaluationJob(jobType) {
  return jobType === "prd.evaluate_quality" || jobType === "document.evaluate" || jobType.endsWith(".evaluate");
}

function isPlanningJob(jobType) {
  return jobType === "prd.route_downstream" || jobType === "document.fan_out";
}

function isRevisionJob(jobType) {
  return jobType === "prd.apply_feedback_revision" || jobType === "document.revise" || jobType.endsWith(".revise");
}

function isImplementationOpenPrJob(jobType) {
  return jobType === "implementation.open_pr";
}

function isImplementationUpdateJob(jobType) {
  return jobType === "implementation.update_pr";
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
