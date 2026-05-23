import type { ExternalIssue } from "./external-issue";

export interface JiraRestClientOptions {
  baseUrl: string;
  email?: string;
  apiToken: string;
  authMode?: "basic" | "bearer";
  apiVersion?: "2" | "3";
  writebackFieldIds?: JiraWritebackFieldIds;
  transitionIds?: JiraTransitionIds;
}

export interface JiraWritebackFieldIds {
  workflowRunId?: string;
  currentArtifactUrl?: string;
  gateStatus?: string;
  qualityScore?: string;
}

export interface JiraTransitionIds {
  awaitingApproval?: string;
  approved?: string;
  rejected?: string;
  needsRevision?: string;
}

export interface JiraWorkflowStatusWriteback {
  issueKey: string;
  workflowRunId?: string;
  currentArtifactUrl?: string;
  gateStatus?: string;
  qualityScore?: number;
  comment?: string;
  transition?: keyof JiraTransitionIds;
  transitionId?: string;
}

export interface JiraWorkflowStatusWritebackResult {
  fieldsUpdated: string[];
  commentCreated: boolean;
  transitioned: boolean;
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
  private readonly writebackFieldIds: JiraWritebackFieldIds;
  private readonly transitionIds: JiraTransitionIds;

  constructor(options: JiraRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "3";
    this.authorization = buildAuthorization(options);
    this.writebackFieldIds = options.writebackFieldIds ?? {};
    this.transitionIds = options.transitionIds ?? {};
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

  async writeWorkflowStatus(input: JiraWorkflowStatusWriteback): Promise<JiraWorkflowStatusWritebackResult> {
    const fields = this.workflowStatusFields(input);
    const transitionId = input.transitionId ?? (input.transition ? this.transitionIds[input.transition] : undefined);

    if (input.transition && !transitionId) {
      throw new Error(`Jira transition id is not configured for ${input.transition}`);
    }

    if (Object.keys(fields).length > 0) {
      await this.putIssueFields(input.issueKey, fields);
    }

    if (input.comment) {
      await this.addComment(input.issueKey, input.comment);
    }

    if (transitionId) {
      await this.transitionIssue(input.issueKey, transitionId);
    }

    return {
      fieldsUpdated: Object.keys(fields),
      commentCreated: Boolean(input.comment),
      transitioned: Boolean(transitionId)
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

  private workflowStatusFields(input: JiraWorkflowStatusWriteback): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    addWritebackField(fields, this.writebackFieldIds, "workflowRunId", input.workflowRunId);
    addWritebackField(fields, this.writebackFieldIds, "currentArtifactUrl", input.currentArtifactUrl);
    addWritebackField(fields, this.writebackFieldIds, "gateStatus", input.gateStatus);
    addWritebackField(fields, this.writebackFieldIds, "qualityScore", input.qualityScore);

    return fields;
  }

  private async putIssueFields(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.issueUrl(issueKey)}`, {
      method: "PUT",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ fields })
    });

    await requireOk(response, `Jira issue field writeback failed for ${issueKey}`);
  }

  private async addComment(issueKey: string, comment: string): Promise<void> {
    const response = await fetch(`${this.issueUrl(issueKey)}/comment`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ body: commentBodyForApiVersion(comment, this.apiVersion) })
    });

    await requireOk(response, `Jira issue comment writeback failed for ${issueKey}`);
  }

  private async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const response = await fetch(`${this.issueUrl(issueKey)}/transitions`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({ transition: { id: transitionId } })
    });

    await requireOk(response, `Jira issue transition failed for ${issueKey}`);
  }

  private issueUrl(issueKey: string): string {
    return `${this.baseUrl}/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueKey)}`;
  }

  private jsonHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      authorization: this.authorization,
      "content-type": "application/json"
    };
  }
}

function addWritebackField(
  fields: Record<string, unknown>,
  fieldIds: JiraWritebackFieldIds,
  key: keyof JiraWritebackFieldIds,
  value: string | number | undefined
): void {
  if (value === undefined || value === null) {
    return;
  }

  const fieldId = fieldIds[key];

  if (!fieldId) {
    throw new Error(`Jira writeback field id is not configured for ${key}`);
  }

  fields[fieldId] = value;
}

function commentBodyForApiVersion(comment: string, apiVersion: "2" | "3"): unknown {
  if (apiVersion === "2") {
    return comment;
  }

  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: comment
          }
        ]
      }
    ]
  };
}

async function requireOk(response: Response, message: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text();
  throw new Error(`${message}: HTTP ${response.status} ${body}`);
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
