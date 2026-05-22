import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalRunnerPreflight } from "../backend/src/local-runner/preflight";

describe("local runner preflight", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
    cleanupRoots.length = 0;
  });

  it("passes for a scoped document runner with a writable workspace and CLI command", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-runner-preflight-"));
    cleanupRoots.push(workspaceRoot);

    const report = await runLocalRunnerPreflight({
      WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
      LOCAL_RUNNER_ID: "runner-dev-laptop",
      LOCAL_RUNNER_OWNER_EMAIL: "dev@example.com",
      LOCAL_RUNNER_MODE: "local",
      LOCAL_RUNNER_CAPABILITIES: "document.generate,document.evaluate",
      LOCAL_RUNNER_ENGINES: "codex",
      RUNNER_ENGINE: "codex",
      CODEX_CLI_PATH: process.execPath,
      LOCAL_RUNNER_WORKSPACE_ROOT: workspaceRoot
    });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["api_base_url", "passed"],
      ["runner_identity", "passed"],
      ["runner_scope", "passed"],
      ["cli_engine", "passed"],
      ["github_integration", "passed"],
      ["workspace", "passed"]
    ]);
  });

  it("fails local mode when the owner email is missing", async () => {
    const report = await runLocalRunnerPreflight(
      {
        WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
        LOCAL_RUNNER_ID: "runner-dev-laptop",
        LOCAL_RUNNER_MODE: "local",
        LOCAL_RUNNER_CAPABILITIES: "document.generate",
        RUNNER_ENGINE: "codex",
        CODEX_CLI_PATH: process.execPath
      },
      { checkWorkspace: false }
    );

    expect(report.status).toBe("failed");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "runner_identity",
        status: "failed",
        message: "LOCAL_RUNNER_OWNER_EMAIL is required for local runner mode."
      })
    );
  });

  it("requires GitHub settings for implementation capabilities", async () => {
    const missingGitHub = await runLocalRunnerPreflight(
      {
        WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
        LOCAL_RUNNER_ID: "runner-dev-laptop",
        LOCAL_RUNNER_OWNER_EMAIL: "dev@example.com",
        LOCAL_RUNNER_MODE: "local",
        LOCAL_RUNNER_CAPABILITIES: "implementation.open_pr,implementation.collect_pr_status",
        RUNNER_ENGINE: "codex"
      },
      { checkWorkspace: false }
    );

    expect(missingGitHub.status).toBe("failed");
    expect(missingGitHub.checks).toContainEqual(
      expect.objectContaining({
        id: "github_integration",
        status: "failed",
        details: {
          missing: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"]
        }
      })
    );

    const configuredGitHub = await runLocalRunnerPreflight(
      {
        WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
        LOCAL_RUNNER_ID: "runner-dev-laptop",
        LOCAL_RUNNER_OWNER_EMAIL: "dev@example.com",
        LOCAL_RUNNER_MODE: "local",
        LOCAL_RUNNER_CAPABILITIES: "implementation.open_pr,implementation.collect_pr_status",
        RUNNER_ENGINE: "codex",
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "workflow-app"
      },
      { checkWorkspace: false }
    );

    expect(configuredGitHub.status).toBe("passed");
    expect(configuredGitHub.checks).toContainEqual(
      expect.objectContaining({
        id: "cli_engine",
        status: "passed",
        message: "CLI engine is not required for the configured capabilities."
      })
    );
  });

  it("reports workspace warning when no workspace root is configured", async () => {
    const report = await runLocalRunnerPreflight({
      WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
      LOCAL_RUNNER_ID: "runner-dev-laptop",
      LOCAL_RUNNER_OWNER_EMAIL: "dev@example.com",
      LOCAL_RUNNER_MODE: "local",
      LOCAL_RUNNER_CAPABILITIES: "implementation.open_pr",
      RUNNER_ENGINE: "codex",
      GITHUB_TOKEN: "ghp_secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "workflow-app"
    });

    expect(report.status).toBe("warning");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "workspace",
        status: "warning"
      })
    );
  });

  it("requires a CLI engine for implementation update jobs", async () => {
    const report = await runLocalRunnerPreflight(
      {
        WORKFLOW_API_BASE_URL: "http://127.0.0.1:3000",
        LOCAL_RUNNER_ID: "runner-dev-laptop",
        LOCAL_RUNNER_OWNER_EMAIL: "dev@example.com",
        LOCAL_RUNNER_MODE: "local",
        LOCAL_RUNNER_CAPABILITIES: "implementation.update_pr",
        RUNNER_ENGINE: "codex",
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "workflow-app"
      },
      { checkWorkspace: false }
    );

    expect(report.status).toBe("failed");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "cli_engine",
        status: "failed",
        message: "CODEX_CLI_PATH is required for CLI-backed capabilities."
      })
    );
  });
});
