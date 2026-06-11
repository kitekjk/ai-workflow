// app/tests/cli-engine.test.ts
import { engineConfigFromEnv } from "../src/cli-engine";

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
