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
    expect(config.args[0]).toMatch(/document-runner-engine\.mjs$/);
    expect(config.timeoutMs).toBeGreaterThan(180000);
  });

  it("resolves CLI settings from the job template and selected job engine", () => {
    const config = createCliEngineConfig(
      {
        RUNNER_ENGINE: "claude",
        CLAUDE_CLI_PATH: "claude",
        CODEX_CLI_PATH: "codex",
        RUNNER_CLI_TIMEOUT_MS: "120000",
        RUNNER_CLI_MODEL: "env-model"
      },
      {
        workspaceDir: "C:/runner/job_1",
        runner: {
          defaultEngine: "claude",
          engines: ["claude", "codex"]
        },
        job: {
          requiredEngine: "codex",
          input: {
            runnerJobTemplate: {
              runner: {
                command: "custom-codex",
                model: "gpt-5.3-codex",
                timeoutMs: 45000,
                sandbox: "workspace-write",
                workdir: "implementation"
              }
            }
          }
        }
      }
    );

    expect(config.engine).toBe("codex");
    expect(config.args).toEqual(
      expect.arrayContaining([
        "--engine",
        "codex",
        "--bin",
        "custom-codex",
        "--timeout-ms",
        "45000",
        "--model",
        "gpt-5.3-codex",
        "--sandbox",
        "workspace-write",
        "--workdir",
        expect.stringMatching(/job_1[\\/]implementation$/)
      ])
    );
    expect(config.cwd).toMatch(/job_1[\\/]implementation$/);
    expect(config.timeoutMs).toBe(55000);
  });

  it("rejects job template workdirs outside the prepared runner workspace", () => {
    expect(() =>
      createCliEngineConfig(
        {
          RUNNER_ENGINE: "codex",
          CODEX_CLI_PATH: "codex"
        },
        {
          workspaceDir: "C:/runner/job_1",
          job: {
            input: {
              runnerJobTemplate: {
                runner: {
                  workdir: "../other-job"
                }
              }
            }
          }
        }
      )
    ).toThrow(/must stay inside runner workspace/);
  });
});
