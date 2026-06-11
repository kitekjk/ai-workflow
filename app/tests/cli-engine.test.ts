// app/tests/cli-engine.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineConfigFromEnv, buildWrapperPrompt, makeClaudeSkill } from "../src/cli-engine";
import type { RunClaude } from "../src/cli-engine";
import type { StrategyDef } from "../src/strategy";

describe("engineConfigFromEnv", () => {
  it("uses defaults when env is empty", () => {
    const c = engineConfigFromEnv({});
    expect(c.cliPath).toBe("claude");
    expect(c.timeoutMs).toBe(120000);
    expect(c.workspaceBase).toBe(".workspaces");
    expect(c.model).toBeUndefined();
    expect(c.maxTurns).toBeUndefined();
  });

  it("reads overrides from env", () => {
    const c = engineConfigFromEnv({
      CLAUDE_CLI_PATH: "/usr/local/bin/claude",
      SKILL_TIMEOUT_MS: "5000",
      SKILL_MODEL: "claude-opus-4-8",
      SKILL_MAX_TURNS: "3",
      SKILL_WORKSPACE_BASE: "/tmp/ws",
    });
    expect(c).toEqual({
      cliPath: "/usr/local/bin/claude",
      timeoutMs: 5000,
      model: "claude-opus-4-8",
      maxTurns: 3,
      workspaceBase: "/tmp/ws",
    });
  });
});

describe("buildWrapperPrompt", () => {
  const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
  const input = {
    jobId: "job-1",
    inlineInputs: { ticket: "PAIR-1" },
    inputRefs: [{ system: "git", key: "abc123" }],
  };

  it("names the skill and the job type", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("prd.generate");
    expect(p).toContain("generate");
  });

  it("includes the inputs but NOT the internal jobId", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("PAIR-1");
    expect(p).toContain("abc123");
    expect(p).not.toContain("job-1");
  });

  it("states the envelope output path and inlines the schema", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("./out/envelope.json");
    expect(p).toContain("domainOutput");
    expect(p).toContain('"summary"');
  });
});

const strategy: StrategyDef = {
  version: 1,
  type: "prd",
  meta: {},
  jobs: {
    generate: { skill: "prd.generate", outputSchema: { type: "object" } },
  },
};

const cfg = () => ({
  cliPath: "claude",
  timeoutMs: 1000,
  workspaceBase: mkdtempSync(join(tmpdir(), "engine-")),
});

const input = { jobId: "job-1", inlineInputs: {}, inputRefs: [] };

describe("makeClaudeSkill", () => {
  it("returns the envelope the skill wrote to the workspace file", async () => {
    const fakeRun: RunClaude = async (_c, cwd) => {
      writeFileSync(
        join(cwd, "out", "envelope.json"),
        JSON.stringify({ domainOutput: { summary: "ok" }, refs: [] }),
      );
      return { stdout: "done", stderr: "", code: 0 };
    };
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    const env = await skill("generate", input);
    expect(env.domainOutput.summary).toBe("ok");
  });

  it("throws with stdout+stderr when claude exits non-zero (F9)", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "OUT", stderr: "BOOM", code: 1 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    await expect(skill("generate", input)).rejects.toThrow(/OUT[\s\S]*BOOM/);
  });

  it("throws when no envelope file was written", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "", stderr: "", code: 0 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    await expect(skill("generate", input)).rejects.toThrow(/envelope file/);
  });

  it("throws on an unknown job type", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "", stderr: "", code: 0 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    // @ts-expect-error deliberately unknown job type
    await expect(skill("nope", input)).rejects.toThrow(/no jobDef/);
  });
});

// Real `claude` spawn. Gated like the MySQL integration tests. The wrapper prompt fully
// specifies the task, so this exercises the engine I/O path (spawn → file → read) even if
// the prd-cycle skill is not separately installed.
const RUN_CLI = process.env.RUN_CLI_TESTS === "1";
(RUN_CLI ? describe : describe.skip)("makeClaudeSkill (real claude)", () => {
  it("round-trips an envelope file from a real claude run", async () => {
    const s: StrategyDef = {
      version: 1,
      type: "prd",
      meta: {},
      jobs: {
        generate: {
          skill: "prd-cycle",
          outputSchema: {
            type: "object",
            required: ["summary"],
            properties: { summary: { type: "string" } },
          },
        },
      },
    };
    const skill = makeClaudeSkill(s, engineConfigFromEnv());
    const env = await skill("generate", {
      jobId: "it-1",
      inlineInputs: { ticket: "PAIR-1: build login" },
      inputRefs: [],
    });
    expect(typeof env.domainOutput.summary).toBe("string");
  }, 120000);
});
