import {
  prdConfirmationWorkflowPolicy,
  type Artifact as LegacyArtifact,
  type FeedbackItem,
  type AgentJobResult,
  type PrdConfirmationStore,
  type PrdConfirmationWorkflowPolicy,
  type WorkItem
} from "./domain";
import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult, WorkflowRun } from "../workflow-core/domain";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";

export interface GenericPrdSnapshot {
  workflowRuns: WorkflowRun[];
  workflowJobs: WorkflowJob[];
  workflowJobResults: WorkflowJobResult[];
  documents: Document[];
  documentVersions: DocumentVersion[];
  qualityResults: DocumentQualityResult[];
  artifacts: Artifact[];
  feedbackItems: FeedbackItem[];
  policy: PrdConfirmationWorkflowPolicy;
}

export function createGenericPrdSnapshot(store: PrdConfirmationStore): GenericPrdSnapshot {
  const workflowRuns = uniqueWorkflowRuns(store);
  const workflowJobs = store.agentJobs.map((job) => {
    const workItem = requireWorkItem(store, job.workItemId);
    const createdAt = "2026-01-01T00:00:00.000Z";

    return createWorkflowJobRecord({
      id: job.id,
      runId: workItem.runId,
      jobType: job.jobType,
      status: job.status,
      input: job.input,
      projectId: "prd-confirmation",
      repositoryId: "prd-docs",
      createdAt,
      updatedAt: createdAt
    });
  });
  const workflowJobResults = createWorkflowJobResults(store);
  const documentVersions = createDocumentVersions(store);
  const qualityResults = createQualityResults(store, documentVersions);
  const documents = store.workItems.map((workItem) => toDocument(store, workItem, documentVersions));
  const artifacts = store.artifacts.map((artifact, index) => toArtifact(store, artifact, index, documentVersions));

  return {
    workflowRuns,
    workflowJobs,
    workflowJobResults,
    documents,
    documentVersions,
    qualityResults,
    artifacts,
    feedbackItems: [...store.feedbackItems],
    policy: prdConfirmationWorkflowPolicy
  };
}

function createWorkflowJobResults(store: PrdConfirmationStore): WorkflowJobResult[] {
  const attemptsByJob = new Map<string, number>();

  return store.agentJobResults.map((result, index) => {
    const job = store.agentJobs.find((candidate) => candidate.id === result.jobId);
    const attemptNo = (attemptsByJob.get(result.jobId) ?? 0) + 1;
    attemptsByJob.set(result.jobId, attemptNo);

    return {
      id: `result_${index + 1}`,
      jobId: result.jobId,
      attemptNo,
      status: workflowJobResultStatusFor(result, job?.status),
      output: result.output,
      errorCode: typeof result.output.errorCode === "string" ? result.output.errorCode : undefined,
      errorMessage: typeof result.output.error === "string" ? result.output.error : undefined,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
  });
}

function workflowJobResultStatusFor(
  result: AgentJobResult,
  jobStatus: string | undefined
): WorkflowJobResult["status"] {
  if (jobStatus === "failed" || result.output.status === "failed") {
    return "failed";
  }

  return "succeeded";
}

function toWorkflowRun(workItem: WorkItem): WorkflowRun {
  const createdAt = "2026-01-01T00:00:00.000Z";

  return {
    id: workItem.runId,
    workflowDefinitionId: "prd_confirmation",
    status: workItem.state === "failed" ? "failed" : "active",
    sourceType: "jira",
    sourceKey: workItem.primaryJiraKey,
    outputLanguage: "ko",
    createdAt,
    updatedAt: createdAt
  };
}

function uniqueWorkflowRuns(store: PrdConfirmationStore): WorkflowRun[] {
  const runs = new Map<string, WorkflowRun>();

  for (const workItem of store.workItems) {
    if (!runs.has(workItem.runId)) {
      runs.set(workItem.runId, toWorkflowRun(workItem));
    }
  }

  return Array.from(runs.values());
}

function toDocument(
  store: PrdConfirmationStore,
  workItem: WorkItem,
  documentVersions: DocumentVersion[]
): Document {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const documentId = documentIdForWorkItem(workItem);
  const currentMarkdownArtifact = findLatestDocumentArtifact(store, workItem, "markdown");
  const currentWikiArtifact = findLatestDocumentArtifact(store, workItem, "wiki");
  const currentVersion = documentVersions.filter((version) => version.documentId === documentId).at(-1);

  return {
    id: documentId,
    workflowRunId: workItem.runId,
    parentDocumentId: workItem.parentWorkItemId ? `doc_${workItem.parentWorkItemId}` : undefined,
    type: workItem.artifactType,
    sourceKey: workItem.primaryJiraKey,
    title: workItem.title ?? workItem.primaryJiraKey,
    status: documentStatusForWorkItem(workItem),
    currentVersionId: currentVersion?.id,
    currentMarkdownArtifactId: currentMarkdownArtifact
      ? artifactIdForLegacyArtifact(store, currentMarkdownArtifact)
      : undefined,
    currentWikiArtifactId: currentWikiArtifact ? artifactIdForLegacyArtifact(store, currentWikiArtifact) : undefined,
    createdAt,
    updatedAt: createdAt
  };
}

function toArtifact(
  store: PrdConfirmationStore,
  artifact: LegacyArtifact,
  index: number,
  documentVersions: DocumentVersion[]
): Artifact {
  const job = store.agentJobs.find((candidate) => candidate.id === artifact.jobId);
  const workItem = job ? requireWorkItem(store, job.workItemId) : undefined;
  const documentId = workItem ? documentIdForWorkItem(workItem) : undefined;
  const documentVersion = documentVersions.find(
    (version) => version.documentId === documentId && version.producerJobId === artifact.jobId
  );

  return {
    id: `art_${index + 1}`,
    documentId,
    documentVersionId: documentVersion?.id,
    producerJobId: artifact.jobId,
    type: artifactTypeFor(artifact),
    location: artifact.location,
    uri: artifact.url,
    externalId: artifact.externalId,
    externalVersion: artifact.externalVersion,
    metadata: {
      ...(artifact.metadata ?? {}),
      legacyType: artifact.type
    },
    createdAt: artifact.createdAt ?? "2026-01-01T00:00:00.000Z"
  };
}

function createDocumentVersions(store: PrdConfirmationStore): DocumentVersion[] {
  const versionsByDocument = new Map<string, number>();
  const versions: DocumentVersion[] = [];

  for (const artifact of store.artifacts) {
    if (artifact.type !== "prd_markdown" && artifact.type !== "document_markdown") {
      continue;
    }

    const job = store.agentJobs.find((candidate) => candidate.id === artifact.jobId);
    const workItem = job ? requireWorkItem(store, job.workItemId) : undefined;

    if (!job || !workItem) {
      continue;
    }

    const documentId = documentIdForWorkItem(workItem);
    const version = (versionsByDocument.get(documentId) ?? 0) + 1;
    const result = store.agentJobResults.find((candidate) => candidate.jobId === artifact.jobId);

    versionsByDocument.set(documentId, version);
    versions.push({
      id: `docv_${versions.length + 1}`,
      documentId,
      version,
      producerJobId: artifact.jobId,
      summary: typeof result?.output.summary === "string" ? result.output.summary : undefined,
      revisionSummary: typeof result?.output.revisionSummary === "string" ? result.output.revisionSummary : undefined,
      revisionJobId: isRevisionJob(job.jobType) ? job.id : undefined,
      createdAt: artifact.createdAt ?? "2026-01-01T00:00:00.000Z"
    });
  }

  return versions;
}

function createQualityResults(
  store: PrdConfirmationStore,
  documentVersions: DocumentVersion[]
): DocumentQualityResult[] {
  const qualityResults: DocumentQualityResult[] = [];

  for (const result of store.agentJobResults) {
    if (!isQualityJob(result.jobType)) {
      continue;
    }

    const job = store.agentJobs.find((candidate) => candidate.id === result.jobId);
    const workItem = job ? requireWorkItem(store, job.workItemId) : undefined;

    if (!job || !workItem) {
      continue;
    }

    const documentId = documentIdForWorkItem(workItem);
    const evaluatedVersion = latestVersionBeforeJob(store, documentVersions, documentId, job.id);

    qualityResults.push({
      id: `qgr_${qualityResults.length + 1}`,
      documentId,
      documentVersionId: evaluatedVersion?.id,
      evaluatorJobId: job.id,
      status: result.output.status === "passed" ? "passed" : "needs_revision",
      score: typeof result.output.score === "number" ? result.output.score : undefined,
      summary: typeof result.output.summary === "string" ? result.output.summary : undefined,
      missingInformation: stringArray(result.output.missingInformation),
      clarificationQuestions: stringArray(result.output.clarificationQuestions),
      riskItems: stringArray(result.output.riskItems),
      qualityFailureAction:
        result.output.status === "passed" ? undefined : prdConfirmationWorkflowPolicy.qualityFailureAction,
      autoRevisionScheduled: false,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
  }

  return qualityResults;
}

function latestVersionBeforeJob(
  store: PrdConfirmationStore,
  documentVersions: DocumentVersion[],
  documentId: string,
  jobId: string
): DocumentVersion | undefined {
  const jobIndex = store.agentJobs.findIndex((job) => job.id === jobId);

  return documentVersions
    .filter((version) => {
      if (version.documentId !== documentId) {
        return false;
      }

      const producerIndex = store.agentJobs.findIndex((job) => job.id === version.producerJobId);
      return producerIndex >= 0 && (jobIndex < 0 || producerIndex < jobIndex);
    })
    .at(-1);
}

function requireWorkItem(store: PrdConfirmationStore, workItemId: string): WorkItem {
  const workItem = store.workItems.find((candidate) => candidate.id === workItemId);

  if (!workItem) {
    throw new Error(`No work item found for generic adapter: ${workItemId}`);
  }

  return workItem;
}

function documentIdForWorkItem(workItem: WorkItem): string {
  return `doc_${workItem.id}`;
}

function artifactIdForLegacyArtifact(store: PrdConfirmationStore, artifact: LegacyArtifact): string {
  return `art_${store.artifacts.indexOf(artifact) + 1}`;
}

function findLatestDocumentArtifact(
  store: PrdConfirmationStore,
  workItem: WorkItem,
  type: "markdown" | "wiki"
): LegacyArtifact | undefined {
  const legacyType = workItem.artifactType === "prd" && type === "markdown" ? "prd_markdown" : undefined;
  const legacyWikiType = workItem.artifactType === "prd" && type === "wiki" ? "prd_wiki_page" : undefined;
  const genericType = type === "markdown" ? "document_markdown" : "document_wiki_page";
  const jobIds = store.agentJobs.filter((job) => job.workItemId === workItem.id).map((job) => job.id);

  return store.artifacts
    .filter(
      (artifact) =>
        jobIds.includes(artifact.jobId) &&
        (artifact.type === genericType || artifact.type === legacyType || artifact.type === legacyWikiType)
    )
    .at(-1);
}

function documentStatusForWorkItem(workItem: WorkItem): Document["status"] {
  if (workItem.state === "needs_revision") {
    return "needs_revision";
  }

  if (workItem.state === "awaiting_approval") {
    return "approval_pending";
  }

  if (workItem.state === "approved") {
    return "approved";
  }

  if (
    workItem.state === "implementation_pr_open" ||
    workItem.state === "implementation_in_review" ||
    workItem.state === "implementation_reviewed" ||
    workItem.state === "implementation_merged"
  ) {
    return "approved";
  }

  if (workItem.state === "scope_confirmation_required") {
    return "needs_revision";
  }

  if (workItem.state === "evaluating") {
    return "quality_review";
  }

  return "draft";
}

function isQualityJob(jobType: string): boolean {
  return jobType === "prd.evaluate_quality" || jobType === "document.evaluate";
}

function isRevisionJob(jobType: string): boolean {
  return jobType === "prd.apply_feedback_revision" || jobType === "document.revise";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function artifactTypeFor(artifact: LegacyArtifact): Artifact["type"] {
  if (artifact.type === "pull_request") {
    return "pull_request";
  }

  if (artifact.type === "prd_markdown" || artifact.type === "document_markdown") {
    return "document_markdown";
  }

  return "wiki_page";
}
