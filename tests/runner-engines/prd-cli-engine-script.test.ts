import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("supports generic document runner prompts through the new bridge", () => {
    const dir = mkdtempSync(join(tmpdir(), "document-runner-engine-"));
    const promptFile = join(dir, "prompt.txt");
    const argsFile = join(dir, "args.json");
    const cwdFile = join(dir, "cwd.txt");
    const fakeCodex = join(dir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd().replace(/\\\\/g, "/"));
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
  const outputIndex = args.indexOf("--output-last-message");
  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
    status: "succeeded",
    markdown: "# Generated Spec",
    summary: "Generated with generic bridge"
  }));
});
`
    );
    chmodSync(fakeCodex, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/document-runner-engine.mjs",
        "--engine",
        "codex",
        "--bin",
        fakeCodex,
        "--timeout-ms",
        "5000",
        "--sandbox",
        "workspace-write",
        "--workdir",
        dir
      ],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          jobType: "document.generate",
          documentType: "spec",
          sourceKey: "PRD-100",
          outputLanguage: "ko"
        })
      }
    ).toString();

    const prompt = readFileSync(promptFile, "utf8");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "succeeded",
      markdown: "# Generated Spec"
    });
    expect(prompt).toContain("generating a spec");
    expect(prompt).toContain("generatedFiles");
    expect(prompt).toContain("document.generate");
    expect(prompt).toContain("Prompt contract");
    expect(prompt).toContain("Required markdown sections");
    expect(prompt).toContain("Output JSON Schema");
    expect(prompt).toContain("Implementation Plan");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    expect(readFileSync(cwdFile, "utf8")).toBe(portableRealPath(dir));
  });

  it("builds a code update prompt for implementation PR rework jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "implementation-update-runner-"));
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
    status: "succeeded",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.example/acme/app/pull/42",
    latestCommitSha: "updated-sha",
    summary: "Updated failing unit test"
  }));
});
`
    );
    chmodSync(fakeCodex, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/document-runner-engine.mjs",
        "--engine",
        "codex",
        "--bin",
        fakeCodex,
        "--timeout-ms",
        "5000",
        "--sandbox",
        "workspace-write",
        "--workdir",
        dir
      ],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          jobType: "implementation.update_pr",
          documentType: "spec",
          pullNumber: 42,
          pullRequestUrl: "https://github.example/acme/app/pull/42",
          branchName: "feature/spec-100",
          repositoryCloneUrl: "https://github.example/acme/app.git",
          feedback: "Failing checks: unit",
          outputLanguage: "ko"
        })
      }
    ).toString();

    const prompt = readFileSync(promptFile, "utf8");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "succeeded",
      pullRequestNumber: 42,
      latestCommitSha: "updated-sha"
    });
    expect(prompt).toContain("updating an existing implementation pull request");
    expect(prompt).toContain("current working directory");
    expect(prompt).toContain("Implementation PR Updater");
    expect(prompt).toContain("Commit the code change locally");
    expect(prompt).toContain("implementation.update_pr");
    expect(prompt).toContain("pullRequestNumber");
    expect(prompt).not.toContain('"markdown":"# ..."');
  });

  it("builds an initial code implementation prompt for implementation PR jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "implementation-open-pr-runner-"));
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
    status: "implemented",
    latestCommitSha: "initial-sha",
    summary: "Implemented initial PR",
    pullRequestTitle: "Implement SPEC-100",
    pullRequestBody: "## Summary\\n- Implemented initial PR.\\n\\n## Tests\\n- Not run."
  }));
});
`
    );
    chmodSync(fakeCodex, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/document-runner-engine.mjs",
        "--engine",
        "codex",
        "--bin",
        fakeCodex,
        "--timeout-ms",
        "5000",
        "--sandbox",
        "workspace-write",
        "--workdir",
        dir
      ],
      {
        cwd: process.cwd(),
        input: JSON.stringify({
          jobType: "implementation.open_pr",
          documentType: "spec",
          branchName: "feature/spec-100",
          repositoryCloneUrl: "https://github.example/acme/app.git",
          outputLanguage: "ko"
        })
      }
    ).toString();

    const prompt = readFileSync(promptFile, "utf8");
    expect(JSON.parse(stdout)).toMatchObject({
      status: "implemented",
      latestCommitSha: "initial-sha"
    });
    expect(prompt).toContain("implementing an approved Spec");
    expect(prompt).toContain("preparing its first pull request");
    expect(prompt).toContain("Implementation PR Author");
    expect(prompt).toContain("Commit the code change locally");
    expect(prompt).toContain("pullRequestTitle");
    expect(prompt).toContain("pullRequestBody");
    expect(prompt).toContain("implementation.open_pr");
    expect(prompt).not.toContain('"markdown":"# ..."');
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
    expect(prompt).toContain("Output JSON Schema");
  });
});

function portableRealPath(path: string): string {
  return realpathSync(path).replace(/\\/g, "/");
}
