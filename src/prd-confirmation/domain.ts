export type JiraLinkRole =
  | "primary"
  | "source_request"
  | "revision"
  | "upstream_artifact"
  | "downstream_blocker";

export type AgentJobStatus = "pending" | "claimed" | "running" | "succeeded" | "failed";

export type JobType =
  | "prd.generate_draft"
  | "prd.evaluate_quality"
  | "prd.apply_feedback_revision";

export interface ExternalIssue {
  key: string;
  issueType: "operational_request" | "prd";
  status: string;
  summary: string;
  description?: string;
  linkedSourceKeys?: string[];
}

export interface WorkItem {
  id: string;
  runId: string;
  artifactType: "prd";
  primaryJiraKey: string;
  state: string;
}

export interface WorkItemJiraLink {
  workItemId: string;
  jiraKey: string;
  role: JiraLinkRole;
}

export interface AgentJob {
  id: string;
  workItemId: string;
  jobType: JobType;
  primaryJiraKey: string;
  status: AgentJobStatus;
  input: Record<string, unknown>;
}

export interface Artifact {
  jobId: string;
  type: "prd_markdown" | "prd_wiki_page";
  location: "git" | "wiki";
  url: string;
  createdAt?: string;
}

export interface AgentJobResult {
  jobId: string;
  jobType: JobType;
  primaryJiraKey: string;
  output: Record<string, unknown>;
  processed: boolean;
}

export interface PrdConfirmationStore {
  externalIssues: Map<string, ExternalIssue>;
  workItems: WorkItem[];
  workItemJiraLinks: WorkItemJiraLink[];
  agentJobs: AgentJob[];
  agentJobResults: AgentJobResult[];
  artifacts: Artifact[];
}

export function createEmptyStore(): PrdConfirmationStore {
  return {
    externalIssues: new Map(),
    workItems: [],
    workItemJiraLinks: [],
    agentJobs: [],
    agentJobResults: [],
    artifacts: []
  };
}
