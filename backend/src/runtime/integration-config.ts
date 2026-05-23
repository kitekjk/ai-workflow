import type { ExternalIssue } from "../integrations/external-issue";
import { ConfluenceWikiPublisher } from "../integrations/confluence-wiki";
import type { GitHubRestClientOptions } from "../integrations/github-client";
import { JiraRestClient } from "../integrations/jira-client";
import type { JiraIssueReader } from "../integrations/workflow-ports";

export interface GitHubRuntimeConfig extends GitHubRestClientOptions {
  defaultBaseBranch: string;
}

export function createJiraIssueReaderFromEnv(env: NodeJS.ProcessEnv): JiraIssueReader {
  return new JiraRestClient({
    baseUrl: requireEnv(env, "JIRA_BASE_URL"),
    email: env.JIRA_EMAIL,
    apiToken: requireEnv(env, "JIRA_API_TOKEN"),
    authMode: parseJiraAuthMode(env.JIRA_AUTH_MODE),
    apiVersion: parseJiraApiVersion(env.JIRA_API_VERSION),
    writebackFieldIds: jiraWritebackFieldIds(env),
    transitionIds: jiraTransitionIds(env)
  });
}

export function createStubJiraIssueReader(): JiraIssueReader {
  const issues = new Map<string, ExternalIssue>(
    stubExternalIssues().map((issue) => [issue.key, issue])
  );

  return {
    async loadPrdWithSources(prdJiraKey) {
      const prd = issues.get(prdJiraKey) ?? syntheticStubPrd(prdJiraKey);

      if (!prd || prd.issueType !== "prd") {
        throw new Error(`PRD Jira ticket is not readable: ${prdJiraKey}`);
      }

      return {
        prd: cloneExternalIssue(prd),
        sources: (prd.linkedSourceKeys ?? []).map((sourceKey) => {
          const source = issues.get(sourceKey);

          if (!source) {
            throw new Error(`Linked source request is not readable: ${sourceKey}`);
          }

          return cloneExternalIssue(source);
        })
      };
    }
  };
}

export function maybeCreateConfluenceWikiPublisher(env: NodeJS.ProcessEnv): ConfluenceWikiPublisher | undefined {
  const hasConfig = Boolean(env.CONFLUENCE_BASE_URL || env.CONFLUENCE_EMAIL || env.CONFLUENCE_API_TOKEN);

  return hasConfig ? createConfluenceWikiPublisher(env) : undefined;
}

export function createConfluenceWikiPublisher(env: NodeJS.ProcessEnv): ConfluenceWikiPublisher {
  return new ConfluenceWikiPublisher({
    baseUrl: requireEnv(env, "CONFLUENCE_BASE_URL"),
    email: requireEnv(env, "CONFLUENCE_EMAIL"),
    apiToken: requireEnv(env, "CONFLUENCE_API_TOKEN"),
    spaceKey: requireEnv(env, "CONFLUENCE_SPACE_KEY"),
    parentPageId: requireEnv(env, "CONFLUENCE_PARENT_PAGE_ID"),
    parentPageIdByDocumentType: confluenceParentPageIdsByDocumentType(env)
  });
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

export function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required when INTEGRATION_MODE=real`);
  }

  return value;
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

function optionalParentPageId(env: NodeJS.ProcessEnv, documentType: string, key: string): Record<string, string> {
  return optionalEnvValue(env, documentType, key);
}

function optionalEnvValue(env: NodeJS.ProcessEnv, outputKey: string, key: string): Record<string, string> {
  const value = env[key]?.trim();

  return value ? { [outputKey]: value } : {};
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`${key} is required when GitHub integration is configured`);
  }

  return value;
}

function stubExternalIssues(): ExternalIssue[] {
  return [
    {
      key: "OPS-1",
      issueType: "operational_request",
      status: "open",
      summary: "Reduce repeated FAQ handling",
      description: "Operations wants fewer repeated FAQ responses."
    },
    {
      key: "OPS-2",
      issueType: "operational_request",
      status: "open",
      summary: "Improve answer consistency",
      description: "Operators need consistent answers for common customer questions."
    },
    {
      key: "PRD-100",
      issueType: "prd",
      status: "prd_requested",
      summary: "FAQ automation PRD",
      linkedSourceKeys: ["OPS-1", "OPS-2"]
    }
  ];
}

function cloneExternalIssue(issue: ExternalIssue): ExternalIssue {
  return {
    ...issue,
    linkedSourceKeys: issue.linkedSourceKeys ? [...issue.linkedSourceKeys] : undefined
  };
}

function syntheticStubPrd(key: string): ExternalIssue | undefined {
  if (!/^PRD-SMOKE-[A-Za-z0-9-]+$/.test(key)) {
    return undefined;
  }

  return {
    key,
    issueType: "prd",
    status: "prd_requested",
    summary: `${key} smoke PRD`,
    linkedSourceKeys: ["OPS-1"]
  };
}
