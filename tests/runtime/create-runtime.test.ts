import { describe, expect, it } from "vitest";
import { AdapterBackedPrdSkills } from "../../src/prd-confirmation/adapter-backed-skills";
import { CliPrdSkills } from "../../src/prd-confirmation/cli-prd-skills";
import { StubPrdSkills } from "../../src/prd-confirmation/runner-skills";
import { createRuntimeFromEnv } from "../../src/runtime/create-runtime";

describe("createRuntimeFromEnv", () => {
  it("uses seeded stub runtime when integration mode is not real", () => {
    const runtime = createRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      STUB_QUALITY_PASSES: "false"
    });

    expect(runtime.skills).toBeInstanceOf(StubPrdSkills);
    expect(runtime.store.externalIssues.has("PRD-100")).toBe(true);
    expect(runtime.skills.qualityPasses).toBe(false);
  });

  it("uses stub PRD skills in real integration mode when RUNNER_SKILL_MODE=stub", () => {
    const runtime = createRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "stub",
      STUB_QUALITY_PASSES: "false"
    });

    expect(runtime.skills).toBeInstanceOf(StubPrdSkills);
    expect(runtime.skills.qualityPasses).toBe(false);
  });

  it("uses adapter-backed PRD skills in real integration mode when RUNNER_SKILL_MODE=adapter", () => {
    const runtime = createRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "adapter"
    });

    expect(runtime.skills).toBeInstanceOf(AdapterBackedPrdSkills);
  });

  it("uses Claude CLI PRD skills in real integration mode when requested", () => {
    const runtime = createRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "cli",
      RUNNER_ENGINE: "claude",
      CLAUDE_CLI_PATH: "claude",
      RUNNER_CLI_TIMEOUT_MS: "30000"
    });

    expect(runtime.skills).toBeInstanceOf(CliPrdSkills);
  });

  it("uses Codex CLI PRD skills in real integration mode when requested", () => {
    const runtime = createRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "cli",
      RUNNER_ENGINE: "codex",
      CODEX_CLI_PATH: "codex"
    });

    expect(runtime.skills).toBeInstanceOf(CliPrdSkills);
  });

  it("throws a clear env error when the selected CLI path is missing", () => {
    expect(() =>
      createRuntimeFromEnv({
        ...realEnv(),
        RUNNER_SKILL_MODE: "cli",
        RUNNER_ENGINE: "claude"
      })
    ).toThrow(/CLAUDE_CLI_PATH is required when RUNNER_SKILL_MODE=cli/);
  });
});

function realEnv(): NodeJS.ProcessEnv {
  return {
    INTEGRATION_MODE: "real",
    JIRA_BASE_URL: "https://example.atlassian.net",
    JIRA_EMAIL: "workflow@example.com",
    JIRA_API_TOKEN: "jira-token",
    PRD_REPO_PATH: "/tmp/prd-repo",
    CONFLUENCE_BASE_URL: "https://example.atlassian.net",
    CONFLUENCE_EMAIL: "workflow@example.com",
    CONFLUENCE_API_TOKEN: "wiki-token",
    CONFLUENCE_SPACE_KEY: "PRD",
    CONFLUENCE_PARENT_PAGE_ID: "123"
  };
}
