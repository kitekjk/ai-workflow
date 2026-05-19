import { describe, expect, it } from "vitest";
import { createCliEngineConfig } from "../../src/runner-engines/engine-config";

describe("createCliEngineConfig", () => {
  it("gives the bridge process more time than the selected CLI child timeout", () => {
    const config = createCliEngineConfig({
      RUNNER_ENGINE: "codex",
      CODEX_CLI_PATH: "codex",
      RUNNER_CLI_TIMEOUT_MS: "180000"
    });

    expect(config.args).toEqual(
      expect.arrayContaining(["--engine", "codex", "--bin", "codex", "--timeout-ms", "180000"])
    );
    expect(config.timeoutMs).toBeGreaterThan(180000);
  });
});
