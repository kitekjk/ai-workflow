import { describe, expect, it } from "vitest";
import { AdapterBackedPrdSkills } from "../../backend/src/legacy/prd-confirmation/adapter-backed-skills";
import { CliPrdSkills } from "../../backend/src/legacy/prd-confirmation/cli-prd-skills";
import { StubPrdSkills } from "../../backend/src/legacy/prd-confirmation/runner-skills";
import {
  createWorkflowApiRuntimeFromEnv,
  parseLeaseMs,
  parseRunnerOfflineAfterMs,
  parseWorkflowApiAuthConfig,
  parseWorkflowRuntimeStore
} from "../../backend/src/runtime/create-workflow-api-runtime";
import {
  confluenceParentPageIdsByDocumentType,
  createStubJiraIssueReader,
  githubRuntimeConfig,
  jiraTransitionIds,
  jiraWritebackFieldIds
} from "../../backend/src/runtime/integration-config";
import { createLegacyPrdRuntimeFromEnv } from "../../backend/src/runtime/legacy-prd-runtime";

describe("createLegacyPrdRuntimeFromEnv", () => {
  it("uses seeded stub runtime when integration mode is not real", () => {
    const runtime = createLegacyPrdRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      STUB_QUALITY_PASSES: "false"
    });

    expect(runtime.skills).toBeInstanceOf(StubPrdSkills);
    expect(runtime.store.externalIssues.has("PRD-100")).toBe(true);
    expect(runtime.skills.qualityPasses).toBe(false);
  });

  it("uses stub PRD skills in real integration mode when RUNNER_SKILL_MODE=stub", () => {
    const runtime = createLegacyPrdRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "stub",
      STUB_QUALITY_PASSES: "false"
    });

    expect(runtime.skills).toBeInstanceOf(StubPrdSkills);
    expect(runtime.skills.qualityPasses).toBe(false);
  });

  it("uses adapter-backed PRD skills in real integration mode when RUNNER_SKILL_MODE=adapter", () => {
    const runtime = createLegacyPrdRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "adapter"
    });

    expect(runtime.skills).toBeInstanceOf(AdapterBackedPrdSkills);
  });

  it("uses Claude CLI PRD skills in real integration mode when requested", () => {
    const runtime = createLegacyPrdRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "cli",
      RUNNER_ENGINE: "claude",
      CLAUDE_CLI_PATH: "claude",
      RUNNER_CLI_TIMEOUT_MS: "30000"
    });

    expect(runtime.skills).toBeInstanceOf(CliPrdSkills);
  });

  it("uses Codex CLI PRD skills in real integration mode when requested", () => {
    const runtime = createLegacyPrdRuntimeFromEnv({
      ...realEnv(),
      RUNNER_SKILL_MODE: "cli",
      RUNNER_ENGINE: "codex",
      CODEX_CLI_PATH: "codex"
    });

    expect(runtime.skills).toBeInstanceOf(CliPrdSkills);
  });

  it("throws a clear env error when the selected CLI path is missing", () => {
    expect(() =>
      createLegacyPrdRuntimeFromEnv({
        ...realEnv(),
        RUNNER_SKILL_MODE: "cli",
        RUNNER_ENGINE: "claude"
      })
    ).toThrow(/CLAUDE_CLI_PATH is required when RUNNER_SKILL_MODE=cli/);
  });

  it("parses optional Confluence parent page routing by document type", () => {
    expect(
      confluenceParentPageIdsByDocumentType({
        CONFLUENCE_PARENT_PAGE_ID_PRD: "111",
        CONFLUENCE_PARENT_PAGE_ID_HLD: "https://example.atlassian.net/wiki/spaces/DOCS/pages/222/HLD",
        CONFLUENCE_PARENT_PAGE_ID_SPEC: "333"
      })
    ).toEqual({
      prd: "111",
      hld: "https://example.atlassian.net/wiki/spaces/DOCS/pages/222/HLD",
      spec: "333"
    });
  });

  it("parses Jira writeback field and transition allowlists", () => {
    expect(
      jiraWritebackFieldIds({
        JIRA_FIELD_WORKFLOW_RUN_ID: "customfield_10010",
        JIRA_FIELD_CURRENT_ARTIFACT_URL: "customfield_10011",
        JIRA_FIELD_GATE_STATUS: "customfield_10012",
        JIRA_FIELD_QUALITY_SCORE: "customfield_10013"
      })
    ).toEqual({
      workflowRunId: "customfield_10010",
      currentArtifactUrl: "customfield_10011",
      gateStatus: "customfield_10012",
      qualityScore: "customfield_10013"
    });
    expect(
      jiraTransitionIds({
        JIRA_TRANSITION_AWAITING_APPROVAL_ID: "21",
        JIRA_TRANSITION_APPROVED_ID: "31",
        JIRA_TRANSITION_REJECTED_ID: "41",
        JIRA_TRANSITION_NEEDS_REVISION_ID: "51"
      })
    ).toEqual({
      awaitingApproval: "21",
      approved: "31",
      rejected: "41",
      needsRevision: "51"
    });
  });

  it("parses optional GitHub integration settings", () => {
    expect(
      githubRuntimeConfig({
        GITHUB_BASE_URL: "https://github.example.com/api/v3",
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "workflow-app",
        GITHUB_API_VERSION: "2022-11-28",
        GITHUB_DEFAULT_BASE_BRANCH: "develop"
      })
    ).toEqual({
      baseUrl: "https://github.example.com/api/v3",
      token: "ghp_secret",
      owner: "acme",
      repo: "workflow-app",
      apiVersion: "2022-11-28",
      defaultBaseBranch: "develop"
    });
    expect(githubRuntimeConfig({})).toBeUndefined();
    expect(
      githubRuntimeConfig({
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "workflow-app"
      })
    ).toBeUndefined();
    expect(() =>
      githubRuntimeConfig({
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "acme"
      })
    ).toThrow("GITHUB_REPO is required when GitHub integration is configured");
  });

  it("provides seeded stub Jira PRD data for local smoke runs", async () => {
    await expect(createStubJiraIssueReader().loadPrdWithSources("PRD-100")).resolves.toEqual({
      prd: {
        key: "PRD-100",
        issueType: "prd",
        status: "prd_requested",
        summary: "FAQ automation PRD",
        linkedSourceKeys: ["OPS-1", "OPS-2"]
      },
      sources: [
        expect.objectContaining({
          key: "OPS-1",
          issueType: "operational_request"
        }),
        expect.objectContaining({
          key: "OPS-2",
          issueType: "operational_request"
        })
      ]
    });
  });

  it("provides synthetic stub Jira PRDs for repeatable smoke runs", async () => {
    await expect(createStubJiraIssueReader().loadPrdWithSources("PRD-SMOKE-20260521")).resolves.toEqual({
      prd: {
        key: "PRD-SMOKE-20260521",
        issueType: "prd",
        status: "prd_requested",
        summary: "PRD-SMOKE-20260521 smoke PRD",
        linkedSourceKeys: ["OPS-1"]
      },
      sources: [
        expect.objectContaining({
          key: "OPS-1",
          issueType: "operational_request"
        })
      ]
    });
  });

  it("wires the stub Jira reader for MySQL no-fixture smoke runs", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled"
    });

    try {
      expect(runtime.jiraIssueReader).toBeDefined();
      await expect(runtime.jiraIssueReader?.loadPrdWithSources("PRD-100")).resolves.toMatchObject({
        prd: {
          key: "PRD-100",
          status: "prd_requested"
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("defaults the API runtime to MySQL without the compatibility fixture", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub"
    });

    try {
      expect(runtime.runtimeStore).toBe("mysql");
      expect(runtime.legacyPrd).toBeUndefined();
      expect(runtime.jiraIssueReader).toBeDefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.documentRepository).toBeDefined();
      expect(runtime.restorePrdSnapshot).toBeUndefined();
      expect(runtime.readModel).toBeDefined();
      expect(runtime.workflowIntakeCommand).toBeDefined();
      expect(runtime.prdIntakeCommand).toBeDefined();
      expect(runtime.feedbackRevisionCommand).toBeDefined();
      expect(runtime.workflowResultCommand).toBeDefined();
      expect(runtime.workflowTransitionCommand).toBeDefined();
      expect(runtime.repositoryTransitionResultReader).toBeDefined();
      expect(runtime.repositoryTransitionIntervalMs).toBe(1_000);
      expect(runtime.internalTickIntervalMs).toBeUndefined();
      expect(runtime.schedulerRecoveryIntervalMs).toBe(1_000);
    } finally {
      await runtime.close();
    }
  });

  it("keeps the legacy memory runtime explicit", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "memory"
    });

    try {
      expect(runtime.runtimeStore).toBe("memory");
      expect(runtime.legacyPrd?.fixture).toBeDefined();
      expect(runtime.scheduler).toBeUndefined();
      expect(runtime.documentRepository).toBeUndefined();
      expect(runtime.internalTickIntervalMs).toBe(1_000);
      expect(runtime.schedulerRecoveryIntervalMs).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("wires MySQL scheduler and document repositories with the legacy fixture when requested", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "enabled",
      WORKFLOW_JOB_LEASE_MS: "45000"
    });

    try {
      expect(runtime.runtimeStore).toBe("mysql");
      expect(runtime.legacyPrd?.fixture).toBeDefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.documentRepository).toBeDefined();
      expect(runtime.legacyPrd?.snapshotMirror).toBeDefined();
      expect(runtime.restorePrdSnapshot).toBeDefined();
      expect(runtime.readModel).toBeDefined();
      expect(runtime.workflowIntakeCommand).toBeDefined();
      expect(runtime.prdIntakeCommand).toBeDefined();
      expect(runtime.feedbackRevisionCommand).toBeDefined();
      expect(runtime.workflowResultCommand).toBeDefined();
      expect(runtime.workflowTransitionCommand).toBeDefined();
      expect(runtime.internalTickIntervalMs).toBe(1_000);
      expect(runtime.schedulerRecoveryIntervalMs).toBe(1_000);
    } finally {
      await runtime.close();
    }
  });

  it("allows the compatibility internal tick interval to be disabled or tuned", async () => {
    const disabledRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "memory",
      WORKFLOW_INTERNAL_TICK_MS: "0"
    });
    const tunedRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "memory",
      WORKFLOW_INTERNAL_TICK_MS: "250"
    });

    try {
      expect(disabledRuntime.internalTickIntervalMs).toBeUndefined();
      expect(tunedRuntime.internalTickIntervalMs).toBe(250);
    } finally {
      await disabledRuntime.close();
      await tunedRuntime.close();
    }
  });

  it("can start the MySQL API runtime without the compatibility fixture", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled"
    });

    try {
      expect(runtime.runtimeStore).toBe("mysql");
      expect(runtime.legacyPrd).toBeUndefined();
      expect(runtime.jiraIssueReader).toBeDefined();
      expect(runtime.wikiFeedbackCollector).toBeUndefined();
      expect(runtime.restorePrdSnapshot).toBeUndefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.documentRepository).toBeDefined();
      expect(runtime.readModel).toBeDefined();
      expect(runtime.workflowIntakeCommand).toBeDefined();
      expect(runtime.prdIntakeCommand).toBeDefined();
      expect(runtime.feedbackRevisionCommand).toBeDefined();
      expect(runtime.workflowResultCommand).toBeDefined();
      expect(runtime.workflowTransitionCommand).toBeDefined();
      expect(runtime.repositoryTransitionResultReader).toBeDefined();
      expect(runtime.repositoryTransitionIntervalMs).toBe(1_000);
      expect(runtime.schedulerRecoveryIntervalMs).toBe(1_000);
      expect(runtime.internalTickIntervalMs).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("allows the repository transition interval to be disabled or tuned", async () => {
    const disabledRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled",
      WORKFLOW_REPOSITORY_TRANSITION_MS: "0"
    });
    const tunedRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled",
      WORKFLOW_REPOSITORY_TRANSITION_MS: "250"
    });

    try {
      expect(disabledRuntime.repositoryTransitionIntervalMs).toBeUndefined();
      expect(tunedRuntime.repositoryTransitionIntervalMs).toBe(250);
    } finally {
      await disabledRuntime.close();
      await tunedRuntime.close();
    }
  });

  it("allows scheduler lease recovery interval to be disabled or tuned", async () => {
    const disabledRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_SCHEDULER_RECOVERY_MS: "0"
    });
    const tunedRuntime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_SCHEDULER_RECOVERY_MS: "250"
    });

    try {
      expect(disabledRuntime.schedulerRecoveryIntervalMs).toBeUndefined();
      expect(tunedRuntime.schedulerRecoveryIntervalMs).toBe(250);
    } finally {
      await disabledRuntime.close();
      await tunedRuntime.close();
    }
  });

  it("wires repository transition worker identity and lease configuration", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      INTEGRATION_MODE: "stub",
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled",
      WORKFLOW_REPOSITORY_TRANSITION_WORKER_ID: "transition-worker-a",
      WORKFLOW_REPOSITORY_TRANSITION_LEASE_MS: "45000"
    });

    try {
      const reader = runtime.repositoryTransitionResultReader as unknown as {
        workerId: string;
        leaseMs: number;
      };

      expect(reader.workerId).toBe("transition-worker-a");
      expect(reader.leaseMs).toBe(45_000);
    } finally {
      await runtime.close();
    }
  });

  it("wires a Jira issue reader for real MySQL runtime without the compatibility fixture", async () => {
    const runtime = createWorkflowApiRuntimeFromEnv({
      ...realEnv(),
      WORKFLOW_RUNTIME_STORE: "mysql",
      WORKFLOW_COMPATIBILITY_FIXTURE: "disabled"
    });

    try {
      expect(runtime.runtimeStore).toBe("mysql");
      expect(runtime.legacyPrd).toBeUndefined();
      expect(runtime.jiraIssueReader).toBeDefined();
      expect(runtime.workflowIntakeCommand).toBeDefined();
      expect(runtime.prdIntakeCommand).toBeDefined();
      expect(runtime.internalTickIntervalMs).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("parses API runtime store and runner lease configuration", () => {
    expect(parseWorkflowRuntimeStore(undefined)).toBe("mysql");
    expect(parseWorkflowRuntimeStore("memory")).toBe("memory");
    expect(parseWorkflowRuntimeStore("mysql")).toBe("mysql");
    expect(() => parseWorkflowRuntimeStore("sqlite")).toThrow(/WORKFLOW_RUNTIME_STORE/);

    expect(parseLeaseMs(undefined)).toBe(30_000);
    expect(parseLeaseMs("15000")).toBe(15_000);
    expect(() => parseLeaseMs("0")).toThrow(/WORKFLOW_JOB_LEASE_MS/);

    expect(parseRunnerOfflineAfterMs(undefined, 15_000)).toBe(30_000);
    expect(parseRunnerOfflineAfterMs("45000")).toBe(45_000);
    expect(() => parseRunnerOfflineAfterMs("0")).toThrow(/WORKFLOW_RUNNER_OFFLINE_AFTER_MS/);
  });

  it("parses optional workflow API app and runner auth tokens", () => {
    expect(parseWorkflowApiAuthConfig({})).toBeUndefined();
    expect(parseWorkflowApiAuthConfig({
      WORKFLOW_APP_API_TOKEN: "app-secret",
      WORKFLOW_RUNNER_TOKENS: "runner-a:token-a,runner-b:token-b"
    })).toEqual({
      appToken: "app-secret",
      runnerTokens: {
        "runner-a": "token-a",
        "runner-b": "token-b"
      }
    });
    expect(parseWorkflowApiAuthConfig({
      WORKFLOW_RUNNER_TOKENS: JSON.stringify({
        "runner-a": "token-a"
      })
    })).toEqual({
      appToken: undefined,
      runnerTokens: {
        "runner-a": "token-a"
      }
    });
    expect(() =>
      parseWorkflowApiAuthConfig({
        WORKFLOW_RUNNER_TOKENS: "runner-a"
      })
    ).toThrow(/WORKFLOW_RUNNER_TOKENS/);
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
