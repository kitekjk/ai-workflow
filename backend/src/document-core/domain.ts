export type DocumentType = "prd" | "hld" | "lld" | "adr" | "spec";
export type DocumentStatus = "draft" | "quality_review" | "needs_revision" | "approval_pending" | "approved" | "canceled";
export type ArtifactType = "document_markdown" | "wiki_page" | "runner_log" | "generated_file" | "pull_request";
export type ArtifactLocation = "git" | "wiki" | "database" | "local_workspace" | "external";
export type FeedbackSource = "app" | "jira" | "wiki" | "github";
export type QualityFailureAction = "human_clarification" | "auto_rewrite" | "manual_or_auto";

export interface Document {
  id: string;
  workflowRunId: string;
  workflowTaskId?: string;
  parentDocumentId?: string;
  type: DocumentType;
  sourceKey: string;
  title: string;
  status: DocumentStatus;
  currentVersionId?: string;
  currentMarkdownArtifactId?: string;
  currentWikiArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  producerJobId: string;
  summary?: string;
  revisionSummary?: string;
  revisionJobId?: string;
  contentHash?: string;
  createdAt: string;
}

export interface DocumentQualityResult {
  id: string;
  documentId: string;
  documentVersionId?: string;
  evaluatorJobId: string;
  status: "passed" | "needs_revision";
  score?: number;
  summary?: string;
  missingInformation: string[];
  clarificationQuestions: string[];
  riskItems: string[];
  qualityFailureAction?: QualityFailureAction;
  autoRevisionScheduled: boolean;
  createdAt: string;
}

export interface Artifact {
  id: string;
  documentId?: string;
  documentVersionId?: string;
  producerJobId: string;
  type: ArtifactType;
  location: ArtifactLocation;
  uri: string;
  externalId?: string;
  externalVersion?: string;
  contentHash?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

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
