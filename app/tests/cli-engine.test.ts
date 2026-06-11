// app/tests/cli-engine.test.ts
import { engineConfigFromEnv, buildWrapperPrompt } from "../src/cli-engine";

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
