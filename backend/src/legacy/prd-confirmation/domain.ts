import type { ExternalIssue } from "../../integrations/external-issue";
import type { FeedbackItem } from "../../document-core/domain";

export type { ExternalIssue } from "../../integrations/external-issue";
export type { FeedbackItem, FeedbackSource, QualityFailureAction } from "../../document-core/domain";
export {
  prdConfirmationWorkflowPolicy
} from "../../workflow-core/domain";
export type {
  ApprovalAction,
  ApprovalRole,
  ApprovalSource,
  RevisionTrigger,
  WorkflowApprovalTransitionPolicy,
  WorkflowPolicy as PrdConfirmationWorkflowPolicy
} from "../../workflow-core/domain";

export type JiraLinkRole =
  | "primary"
  | "source_request"
  | "revision"
  | "upstream_artifact"
  | "downstream_blocker";

export type AgentJobStatus = "pending" | "claimed" | "running" | "succeeded" | "failed";

export type DocumentArtifactType = "prd" | "hld" | "lld" | "adr" | "spec";

export type JobType =
  | "prd.generate_draft"
  | "prd.evaluate_quality"
  | "prd.apply_feedback_revision"
  | "prd.route_downstream"
  | "document.generate"
  | "document.evaluate"
  | "document.revise"
  | "document.fan_out"
  | "implementation.open_pr"
  | "implementation.update_pr"
  | "implementation.collect_pr_status";

export interface WorkItem {
  id: string;
  runId: string;
  artifactType: DocumentArtifactType;
  parentWorkItemId?: string;
  primaryJiraKey: string;
  title?: string;
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
  type: "prd_markdown" | "prd_wiki_page" | "document_markdown" | "document_wiki_page" | "pull_request";
  location: "git" | "wiki" | "external";
  url: string;
  externalId?: string;
  externalVersion?: string;
  metadata?: Record<string, unknown>;
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
  feedbackItems: FeedbackItem[];
}

export function createEmptyStore(): PrdConfirmationStore {
  return {
    externalIssues: new Map(),
    workItems: [],
    workItemJiraLinks: [],
    agentJobs: [],
    agentJobResults: [],
    artifacts: [],
    feedbackItems: []
  };
}
