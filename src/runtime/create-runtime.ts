import { createEmptyStore } from "../prd-confirmation/domain";
import { createPrdConfirmationFixture } from "../prd-confirmation/fixture";
import { PrdConfirmationWorkflow } from "../prd-confirmation/workflow";
import { AdapterBackedPrdSkills } from "../prd-confirmation/adapter-backed-skills";
import { CliPrdSkills } from "../prd-confirmation/cli-prd-skills";
import type { PrdSkillExecutor } from "../prd-confirmation/ports";
import { StubPrdSkills } from "../prd-confirmation/runner-skills";
import { ConfluenceWikiPublisher } from "../integrations/confluence-wiki";
import type { GitHubRestClientOptions } from "../integrations/github-client";
import { JiraRestClient } from "../integrations/jira-client";
import { LocalGitPrdRepository } from "../integrations/local-git-prd-repository";
import { runRunnerWorkerOnce } from "../prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../prd-confirmation/scheduler";
import { runEngineOnce } from "../prd-confirmation/workflow-engine";
import { CliEngine } from "../runner-engines/cli-engine";
import { createCliEngineConfig } from "../runner-engines/engine-config";
import type { WikiFeedbackCollector, WikiPublisher } from "../prd-confirmation/ports";

export interface RuntimeFixture {
  store: ReturnType<typeof createPrdConfirmationFixture>["store"];
  skills: StubPrdSkills | PrdSkillExecutor;
  workflow: PrdConfirmationWorkflow;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  runUntilIdle: () => Promise<void>;
}

export interface GitHubRuntimeConfig extends GitHubRestClientOptions {
  defaultBaseBranch: string;
}

export function createRuntimeFromEnv(env: NodeJS.ProcessEnv): RuntimeFixture {
  if (env.INTEGRATION_MODE !== "real") {
    return createPrdConfirmationFixture({
      qualityPasses: env.STUB_QUALITY_PASSES !== "false"
    });
  }

  const store = createEmptyStore();
  const jiraReader = new JiraRestClient({
    baseUrl: requireEnv(env, "JIRA_BASE_URL"),
    email: env.JIRA_EMAIL,
    apiToken: requireEnv(env, "JIRA_API_TOKEN"),
    authMode: parseJiraAuthMode(env.JIRA_AUTH_MODE),
    apiVersion: parseJiraApiVersion(env.JIRA_API_VERSION),
    writebackFieldIds: jiraWritebackFieldIds(env),
    transitionIds: jiraTransitionIds(env)
  });
  const wikiPublisher = maybeCreateConfluenceWikiPublisher(env);
  const skills = createPrdSkills(env, wikiPublisher);
  const workflow = new PrdConfirmationWorkflow(store, { jiraReader });

  return {
    store,
    skills,
    workflow,
    wikiFeedbackCollector: wikiPublisher,
    runUntilIdle: async () => {
      for (let i = 0; i < 20; i += 1) {
        const progressed = [
          await runSchedulerOnce(store),
          await runRunnerWorkerOnce(store, skills),
          await runEngineOnce(store)
        ].some(Boolean);

        if (!progressed) {
          return;
        }
      }

      throw new Error("Runtime did not become idle");
    }
  };
}

function createPrdSkills(env: NodeJS.ProcessEnv, wikiPublisher?: WikiPublisher): StubPrdSkills | PrdSkillExecutor {
  const mode = parseRunnerSkillMode(env.RUNNER_SKILL_MODE);

  if (mode === "stub") {
    return new StubPrdSkills(env.STUB_QUALITY_PASSES !== "false");
  }

  const prdRepository = new LocalGitPrdRepository({
    repoPath: requireEnv(env, "PRD_REPO_PATH"),
    publicBaseUrl: env.PRD_REPO_PUBLIC_BASE_URL
  });
  const publisher = wikiPublisher ?? createConfluenceWikiPublisher(env);

  if (mode === "cli") {
    const config = createCliEngineConfig(env);
    return new CliPrdSkills({
      engine: new CliEngine({
        command: config.command,
        args: config.args,
        timeoutMs: config.timeoutMs,
        cwd: config.cwd
      }),
      prdRepository,
      wikiPublisher: publisher,
      outputLanguage: env.RUNNER_OUTPUT_LANGUAGE ?? "ko"
    });
  }

  return new AdapterBackedPrdSkills({
    qualityPasses: env.STUB_QUALITY_PASSES !== "false",
    prdRepository,
    wikiPublisher: publisher
  });
}

function maybeCreateConfluenceWikiPublisher(env: NodeJS.ProcessEnv): ConfluenceWikiPublisher | undefined {
  const hasConfig = Boolean(env.CONFLUENCE_BASE_URL || env.CONFLUENCE_EMAIL || env.CONFLUENCE_API_TOKEN);

  return hasConfig ? createConfluenceWikiPublisher(env) : undefined;
}

function createConfluenceWikiPublisher(env: NodeJS.ProcessEnv): ConfluenceWikiPublisher {
  return new ConfluenceWikiPublisher({
    baseUrl: requireEnv(env, "CONFLUENCE_BASE_URL"),
    email: requireEnv(env, "CONFLUENCE_EMAIL"),
    apiToken: requireEnv(env, "CONFLUENCE_API_TOKEN"),
    spaceKey: requireEnv(env, "CONFLUENCE_SPACE_KEY"),
    parentPageId: requireEnv(env, "CONFLUENCE_PARENT_PAGE_ID"),
    parentPageIdByDocumentType: confluenceParentPageIdsByDocumentType(env)
  });
}

function parseRunnerSkillMode(value: string | undefined): "stub" | "adapter" | "cli" {
  if (!value || value === "adapter") {
    return "adapter";
  }

  if (value === "stub" || value === "cli") {
    return value;
  }

  throw new Error(`RUNNER_SKILL_MODE must be "stub", "adapter", or "cli", got: ${value}`);
}

function parseJiraAuthMode(value: string | undefined): "basic" | "bearer" {
  if (value === "bearer") {
    return "bearer";
  }

  return "basic";
}

function parseJiraApiVersion(value: string | undefined): "2" | "3" {
  if (value === "2") {
    return "2";
  }

  return "3";
}

export function confluenceParentPageIdsByDocumentType(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...optionalParentPageId(env, "prd", "CONFLUENCE_PARENT_PAGE_ID_PRD"),
    ...optionalParentPageId(env, "hld", "CONFLUENCE_PARENT_PAGE_ID_HLD"),
    ...optionalParentPageId(env, "lld", "CONFLUENCE_PARENT_PAGE_ID_LLD"),
    ...optionalParentPageId(env, "adr", "CONFLUENCE_PARENT_PAGE_ID_ADR"),
    ...optionalParentPageId(env, "spec", "CONFLUENCE_PARENT_PAGE_ID_SPEC")
  };
}

export function jiraWritebackFieldIds(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...optionalEnvValue(env, "workflowRunId", "JIRA_FIELD_WORKFLOW_RUN_ID"),
    ...optionalEnvValue(env, "currentArtifactUrl", "JIRA_FIELD_CURRENT_ARTIFACT_URL"),
    ...optionalEnvValue(env, "gateStatus", "JIRA_FIELD_GATE_STATUS"),
    ...optionalEnvValue(env, "qualityScore", "JIRA_FIELD_QUALITY_SCORE")
  };
}

export function jiraTransitionIds(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...optionalEnvValue(env, "awaitingApproval", "JIRA_TRANSITION_AWAITING_APPROVAL_ID"),
    ...optionalEnvValue(env, "approved", "JIRA_TRANSITION_APPROVED_ID"),
    ...optionalEnvValue(env, "rejected", "JIRA_TRANSITION_REJECTED_ID"),
    ...optionalEnvValue(env, "needsRevision", "JIRA_TRANSITION_NEEDS_REVISION_ID")
  };
}

export function githubRuntimeConfig(env: NodeJS.ProcessEnv): GitHubRuntimeConfig | undefined {
  const hasGitHubConfig = Boolean(env.GITHUB_TOKEN?.trim());

  if (!hasGitHubConfig) {
    return undefined;
  }

  return {
    baseUrl: env.GITHUB_BASE_URL?.trim() || "https://api.github.com",
    token: requireTrimmedEnv(env, "GITHUB_TOKEN"),
    owner: requireTrimmedEnv(env, "GITHUB_OWNER"),
    repo: requireTrimmedEnv(env, "GITHUB_REPO"),
    apiVersion: env.GITHUB_API_VERSION?.trim() || "2022-11-28",
    defaultBaseBranch: env.GITHUB_DEFAULT_BASE_BRANCH?.trim() || "main"
  };
}

function optionalParentPageId(env: NodeJS.ProcessEnv, documentType: string, key: string): Record<string, string> {
  return optionalEnvValue(env, documentType, key);
}

function optionalEnvValue(env: NodeJS.ProcessEnv, outputKey: string, key: string): Record<string, string> {
  const value = env[key]?.trim();

  return value ? { [outputKey]: value } : {};
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required when INTEGRATION_MODE=real`);
  }

  return value;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`${key} is required when GitHub integration is configured`);
  }

  return value;
}
