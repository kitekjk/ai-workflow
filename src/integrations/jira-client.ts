import type { ExternalIssue } from "../prd-confirmation/domain";

export interface JiraRestClientOptions {
  baseUrl: string;
  email?: string;
  apiToken: string;
  authMode?: "basic" | "bearer";
  apiVersion?: "2" | "3";
}

interface JiraIssueResponse {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string };
    status?: { name?: string };
    issuelinks?: Array<{
      inwardIssue?: { key: string };
      outwardIssue?: { key: string };
    }>;
  };
}

export class JiraRestClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly apiVersion: "2" | "3";

  constructor(options: JiraRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "3";
    this.authorization = buildAuthorization(options);
  }

  async loadPrdWithSources(prdJiraKey: string): Promise<{
    prd: ExternalIssue;
    sources: ExternalIssue[];
  }> {
    const prdIssue = await this.getIssue(prdJiraKey);
    const linkedSourceKeys = extractLinkedIssueKeys(prdIssue);
    const sources = await Promise.all(linkedSourceKeys.map((key) => this.getIssue(key)));

    return {
      prd: {
        key: prdIssue.key,
        issueType: "prd",
        status: normalizeStatus(prdIssue),
        summary: prdIssue.fields.summary ?? prdIssue.key,
        description: stringifyDescription(prdIssue.fields.description),
        linkedSourceKeys
      },
      sources: sources.map((issue) => ({
        key: issue.key,
        issueType: "operational_request",
        status: normalizeStatus(issue),
        summary: issue.fields.summary ?? issue.key,
        description: stringifyDescription(issue.fields.description)
      }))
    };
  }

  private async getIssue(issueKey: string): Promise<JiraIssueResponse> {
    const response = await fetch(`${this.baseUrl}/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueKey)}`, {
      headers: {
        accept: "application/json",
        authorization: this.authorization
      }
    });

    if (!response.ok) {
      throw new Error(`Jira issue read failed for ${issueKey}: HTTP ${response.status}`);
    }

    return response.json() as Promise<JiraIssueResponse>;
  }
}

function buildAuthorization(options: JiraRestClientOptions): string {
  if (options.authMode === "bearer") {
    return `Bearer ${options.apiToken}`;
  }

  if (!options.email) {
    throw new Error("Jira email is required for basic auth");
  }

  return `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`;
}

function extractLinkedIssueKeys(issue: JiraIssueResponse): string[] {
  const keys = new Set<string>();

  for (const link of issue.fields.issuelinks ?? []) {
    const key = link.outwardIssue?.key ?? link.inwardIssue?.key;

    if (key) {
      keys.add(key);
    }
  }

  return [...keys];
}

function normalizeStatus(issue: JiraIssueResponse): string {
  return issue.fields.status?.name?.toLowerCase().replace(/\s+/g, "_") ?? "unknown";
}

function stringifyDescription(description: unknown): string {
  if (typeof description === "string") {
    return description;
  }

  if (!description) {
    return "";
  }

  return JSON.stringify(description);
}
