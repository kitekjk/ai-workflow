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

export type FeedbackSource = "app" | "jira" | "wiki" | "github";

export type ApprovalSource = "jira_status";
export type ApprovalAction = "jira_transition";
export type QualityFailureAction = "human_clarification" | "auto_rewrite" | "manual_or_auto";
export type RevisionTrigger = "explicit_request";
export type ApprovalRole = "planner" | "developer" | "decision_owner";

export interface WorkflowApprovalTransitionPolicy {
  pendingStatus: string;
  approvedStatus: string;
  rejectedStatus: string;
  needsRevisionStatus: string;
}

export interface PrdConfirmationWorkflowPolicy {
  version: "prd-confirmation-policy-v1";
  approvalSource: ApprovalSource;
  approvalAction: ApprovalAction;
  approvalRoles: Record<DocumentArtifactType, ApprovalRole>;
  approvalTransition: WorkflowApprovalTransitionPolicy;
  downstreamStart: "after_jira_approved_status";
  qualityFailureAction: QualityFailureAction;
  revisionTrigger: RevisionTrigger;
  feedbackSources: FeedbackSource[];
}

export const prdConfirmationWorkflowPolicy: PrdConfirmationWorkflowPolicy = {
  version: "prd-confirmation-policy-v1",
  approvalSource: "jira_status",
  approvalAction: "jira_transition",
  approvalRoles: {
    prd: "planner",
    hld: "developer",
    lld: "developer",
    adr: "decision_owner",
    spec: "developer"
  },
  approvalTransition: {
    pendingStatus: "awaiting_approval",
    approvedStatus: "approved",
    rejectedStatus: "rejected",
    needsRevisionStatus: "needs_revision"
  },
  downstreamStart: "after_jira_approved_status",
  qualityFailureAction: "human_clarification",
  revisionTrigger: "explicit_request",
  feedbackSources: ["app", "jira", "wiki", "github"]
};

export interface FeedbackItem {
  id: string;
  workItemId: string;
  documentId: string;
  source: FeedbackSource;
  author?: string;
  body: string;
  createdAt: string;
  externalId?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
  revisionJobId?: string;
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
