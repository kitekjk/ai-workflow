import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("prd-cli-engine script", () => {
  it("calls codex exec with supported non-interactive arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "prd-cli-engine-script-"));
    const argsFile = join(dir, "args.json");
    const fakeCodex = join(dir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex === -1) {
  console.error("missing --output-last-message");
  process.exit(2);
}
if (args.includes("--ask-for-approval")) {
  console.error("unexpected argument '--ask-for-approval' found");
  process.exit(2);
}
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "succeeded",
  markdown: "# Generated PRD",
  summary: "Generated with fake Codex"
}));
`
    );
    chmodSync(fakeCodex, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/prd-cli-engine.mjs",
        "--engine",
        "codex",
        "--bin",
        fakeCodex,
        "--timeout-ms",
        "5000"
      ],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          jobType: "prd.generate_draft",
          primaryJiraKey: "PRD-100",
          sourceRequests: []
        })
      }
    ).toString();

    expect(JSON.parse(stdout)).toMatchObject({
      status: "succeeded",
      markdown: "# Generated PRD"
    });
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).not.toContain("--ask-for-approval");
  });

  it("asks the model to return Korean draft and quality output when outputLanguage is ko", () => {
    const dir = mkdtempSync(join(tmpdir(), "prd-cli-engine-language-"));
    const promptFile = join(dir, "prompt.txt");
    const fakeCodex = join(dir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
  const outputIndex = args.indexOf("--output-last-message");
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
    status: "needs_revision",
    score: 70,
    summary: "한국어 평가 요약",
    missingInformation: [],
    clarificationQuestions: [],
    riskItems: []
  }));
});
`
    );
    chmodSync(fakeCodex, 0o755);

    execFileSync(
      process.execPath,
      [
        "scripts/prd-cli-engine.mjs",
        "--engine",
        "codex",
        "--bin",
        fakeCodex,
        "--timeout-ms",
        "5000"
      ],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          jobType: "prd.evaluate_quality",
          primaryJiraKey: "PRD-100",
          outputLanguage: "ko",
          documentType: "prd",
          currentDocumentMarkdown: "# PRD-100\n\n## 1. 개요"
        })
      }
    );

    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Korean");
    expect(prompt).toContain("currentDocumentMarkdown");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("missingInformation");
  });
});
