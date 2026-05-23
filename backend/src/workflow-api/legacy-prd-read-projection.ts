import type { Document } from "../document-core/domain";
import type { WorkflowJob, WorkflowTask } from "../workflow-core/domain";
import { prdConfirmationWorkflowPolicy } from "../workflow-core/domain";
import type { DocumentCurrentReadModel, WorkflowApiReadModel } from "./mysql-read-model";
import {
  createLegacyPrdSnapshot,
  type LegacyPrdCompatibility,
  type LegacyPrdFixture,
  type LegacyPrdSnapshot
} from "./legacy-prd-compatibility";

export function createLegacyPrdWorkflowApiReadModel(
  legacyPrd: LegacyPrdCompatibility
): WorkflowApiReadModel {
  return new LegacyPrdWorkflowApiReadModel(legacyPrd.fixture);
}

export class LegacyPrdWorkflowApiReadModel implements WorkflowApiReadModel {
  constructor(private readonly fixture: LegacyPrdFixture) {}

  async summarizeState(sourceKey: string): Promise<Record<string, unknown> | undefined> {
    return summarizeLegacyPrdState(this.fixture, sourceKey);
  }

  async listWorkflowRuns(input: { limit?: number } = {}): Promise<LegacyPrdSnapshot["workflowRuns"]> {
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    return createLegacyPrdSnapshot(this.fixture.store).workflowRuns.slice(0, limit);
  }

  async summarizeWorkflowRun(runId: string): Promise<Record<string, unknown> | undefined> {
    return summarizeLegacyPrdWorkflowRunForFixture(this.fixture, runId);
  }

  async summarizeWorkflowRunTree(runId: string): Promise<Record<string, unknown> | undefined> {
    return summarizeLegacyPrdWorkflowRunTreeForFixture(this.fixture, runId);
  }

  async summarizeDocumentCurrent(documentId: string): Promise<DocumentCurrentReadModel | undefined> {
    return summarizeLegacyPrdDocumentCurrentForFixture(this.fixture, documentId) as
      | DocumentCurrentReadModel
      | undefined;
  }

  async summarizeDocumentHistory(documentId: string): Promise<Record<string, unknown> | undefined> {
    return summarizeLegacyPrdDocumentHistoryForFixture(this.fixture, documentId);
  }
}

export function summarizeLegacyPrdState(
  fixture: LegacyPrdFixture,
  prdJiraKey: string
): Record<string, unknown> | undefined {
  const workItemIds = fixture.store.workItems
    .filter((workItem) => workItem.primaryJiraKey === prdJiraKey)
    .map((workItem) => workItem.id);
  const snapshot = createLegacyPrdSnapshot(fixture.store);
  const document = snapshot.documents.find((candidate) => candidate.sourceKey === prdJiraKey);
  const externalIssue = fixture.store.externalIssues.get(prdJiraKey);

  if (workItemIds.length === 0 && !document && !externalIssue) {
    return undefined;
  }

  const currentVersion = document
    ? snapshot.documentVersions.find((version) => version.id === document.currentVersionId)
    : undefined;

  const jobs = fixture.store.agentJobs
    .filter((job) => workItemIds.includes(job.workItemId))
    .map((job) => ({
      id: job.id,
      type: job.jobType,
      jira: job.primaryJiraKey,
      status: job.status
    }));

  return {
    prdJiraKey,
    prdStatus: externalIssue?.status,
    policy: snapshot.policy,
    jobs,
    artifacts: latestArtifacts(fixture.store.artifacts).map((artifact) => ({
      type: artifact.type,
      location: artifact.location,
      url: artifact.url
    })),
    latestQualityResult: document
      ? snapshot.qualityResults
          .filter((qualityResult) => qualityResult.documentId === document.id)
          .at(-1) ?? null
      : null,
    latestRevisionSummary: currentVersion?.revisionSummary ?? null,
    latestResult: fixture.store.agentJobResults.at(-1)?.output ?? null
  };
}

export function summarizeLegacyPrdWorkflowRun(
  snapshot: LegacyPrdSnapshot,
  runId: string
): Record<string, unknown> | undefined {
  const run = snapshot.workflowRuns.find((candidate) => candidate.id === runId);

  if (!run) {
    return undefined;
  }

  return {
    run,
    policy: snapshot.policy,
    tasks: snapshot.workflowTasks.filter((task) => task.runId === runId),
    jobs: snapshot.workflowJobs.filter((job) => job.runId === runId),
    documents: snapshot.documents.filter((document) => document.workflowRunId === runId)
  };
}

export function summarizeLegacyPrdWorkflowRunForFixture(
  fixture: LegacyPrdFixture,
  runId: string
): Record<string, unknown> | undefined {
  return summarizeLegacyPrdWorkflowRun(createLegacyPrdSnapshot(fixture.store), runId);
}

export function summarizeLegacyPrdWorkflowRunTree(
  snapshot: LegacyPrdSnapshot,
  runId: string
): Record<string, unknown> | undefined {
  const summary = summarizeLegacyPrdWorkflowRun(snapshot, runId);

  if (!summary) {
    return undefined;
  }

  const jobs = snapshot.workflowJobs.filter((job) => job.runId === runId);
  const documents = snapshot.documents.filter((document) => document.workflowRunId === runId);
  const tasks = snapshot.workflowTasks.filter((task) => task.runId === runId);

  return {
    run: summary.run,
    policy: snapshot.policy,
    tasks,
    nodes: [
      ...tasks.map((task) => ({
        id: task.id,
        type: "workflow_task",
        parentTaskId: task.parentTaskId,
        taskType: task.taskType,
        status: task.status,
        currentDocumentId: task.currentDocumentId
      })),
      ...jobs.map((job) => ({
        id: job.id,
        type: "workflow_job",
        jobType: job.jobType,
        status: job.status,
        taskId: taskIdForWorkflowJob(job),
        primaryDocumentId: primaryDocumentIdForJob(job, documents, tasks, taskIdForWorkflowJob(job))
      }))
    ],
    edges: workflowRunTreeEdges(tasks, jobs),
    documents
  };
}

export function summarizeLegacyPrdWorkflowRunTreeForFixture(
  fixture: LegacyPrdFixture,
  runId: string
): Record<string, unknown> | undefined {
  return summarizeLegacyPrdWorkflowRunTree(createLegacyPrdSnapshot(fixture.store), runId);
}

export function summarizeLegacyPrdDocumentCurrent(
  fixture: LegacyPrdFixture,
  snapshot: LegacyPrdSnapshot,
  documentId: string
): Record<string, unknown> | undefined {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    return undefined;
  }

  const currentArtifactIds = [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter(
    (id): id is string => Boolean(id)
  );

  return {
    document,
    workflowTask:
      snapshot.workflowTasks.find((task) => task.id === document.workflowTaskId) ??
      snapshot.workflowTasks.find((task) => task.currentDocumentId === documentId) ??
      null,
    policy: snapshot.policy,
    currentVersion:
      snapshot.documentVersions.find((version) => version.id === document.currentVersionId) ?? null,
    latestQualityResult:
      snapshot.qualityResults
        .filter((qualityResult) => qualityResult.documentId === documentId)
        .at(-1) ?? null,
    currentArtifacts: currentArtifactIds
      .map((artifactId) => snapshot.artifacts.find((artifact) => artifact.id === artifactId))
      .filter(Boolean),
    approvalGate: legacyPrdApprovalGateForDocument(fixture, document),
    pendingFeedback: snapshot.feedbackItems.filter(
      (feedback) => feedback.documentId === documentId && !feedback.revisionJobId
    )
  };
}

export function summarizeLegacyPrdDocumentCurrentForFixture(
  fixture: LegacyPrdFixture,
  documentId: string
): Record<string, unknown> | undefined {
  return summarizeLegacyPrdDocumentCurrent(fixture, createLegacyPrdSnapshot(fixture.store), documentId);
}

export function summarizeLegacyPrdDocumentHistory(
  snapshot: LegacyPrdSnapshot,
  documentId: string
): Record<string, unknown> | undefined {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    return undefined;
  }

  return {
    documentId,
    policy: snapshot.policy,
    versions: snapshot.documentVersions.filter((version) => version.documentId === documentId),
    qualityResults: snapshot.qualityResults.filter((qualityResult) => qualityResult.documentId === documentId),
    artifacts: snapshot.artifacts.filter((artifact) => artifact.documentId === documentId),
    feedbackItems: snapshot.feedbackItems.filter((feedback) => feedback.documentId === documentId)
  };
}

export function summarizeLegacyPrdDocumentHistoryForFixture(
  fixture: LegacyPrdFixture,
  documentId: string
): Record<string, unknown> | undefined {
  return summarizeLegacyPrdDocumentHistory(createLegacyPrdSnapshot(fixture.store), documentId);
}

export function requireLegacyPrdDocument(snapshot: LegacyPrdSnapshot, documentId: string): Document {
  const document = snapshot.documents.find((candidate) => candidate.id === documentId);

  if (!document) {
    throw new Error(`Document not found: ${documentId}`);
  }

  return document;
}

export function requireLegacyPrdDocumentForFixture(
  fixture: LegacyPrdFixture,
  documentId: string
): { snapshot: LegacyPrdSnapshot; document: Document } {
  const snapshot = createLegacyPrdSnapshot(fixture.store);

  return {
    snapshot,
    document: requireLegacyPrdDocument(snapshot, documentId)
  };
}

export function legacyPrdCurrentWikiArtifactUri(
  snapshot: LegacyPrdSnapshot,
  document: Document
): string | undefined {
  return document.currentWikiArtifactId
    ? snapshot.artifacts.find((artifact) => artifact.id === document.currentWikiArtifactId)?.uri
    : undefined;
}

export function legacyPrdSnapshotJobAfterAction(
  fixture: LegacyPrdFixture,
  jobId: string
): WorkflowJob | undefined {
  return createLegacyPrdSnapshot(fixture.store).workflowJobs.find((job) => job.id === jobId);
}

export function legacyPrdApprovalGateForDocument(
  fixture: LegacyPrdFixture,
  document: Document
): Record<string, unknown> {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);

  return approvalGateForDocumentState(
    document,
    issue?.status ?? null,
    approvalStatusFor(workItem?.state, issue?.status)
  );
}

export function refreshLegacyPrdApprovalGate(
  fixture: LegacyPrdFixture,
  document: Document
): {
  approvalGate: Record<string, unknown>;
  downstreamJob?: { status: "accepted" | "already_scheduled"; jobId: string };
} {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);
  let downstreamJob: { status: "accepted" | "already_scheduled"; jobId: string } | undefined;

  if (workItem && issue?.status === "approved") {
    workItem.state = "approved";
    downstreamJob = scheduleLegacyPrdDownstreamAfterApproval(fixture, document);
  }

  if (workItem && (issue?.status === "rejected" || issue?.status === "needs_revision")) {
    workItem.state = "needs_revision";
  }

  return {
    approvalGate: legacyPrdApprovalGateForDocument(fixture, document),
    downstreamJob
  };
}

export function transitionLegacyPrdApprovalGate(
  fixture: LegacyPrdFixture,
  document: Document,
  targetStatus: "approved" | "needs_revision",
  metadata: { actor?: string; reason?: string }
): Record<string, unknown> {
  const workItem = workItemForDocument(fixture, document);
  const issue = fixture.store.externalIssues.get(document.sourceKey);
  const fromExternalStatus = issue?.status ?? null;

  if (workItem) {
    workItem.state = targetStatus === "approved" ? "approved" : "needs_revision";
  }

  if (issue) {
    issue.status = targetStatus;
  }

  return {
    ...legacyPrdApprovalGateForDocument(fixture, document),
    lastAction: {
      type: prdConfirmationWorkflowPolicy.approvalAction,
      sourceOfTruth: prdConfirmationWorkflowPolicy.approvalSource,
      actor: metadata.actor,
      reason: metadata.reason,
      fromExternalStatus,
      toExternalStatus: issue?.status ?? targetStatus
    }
  };
}

export function scheduleLegacyPrdDownstreamAfterApproval(
  fixture: LegacyPrdFixture,
  document: Document,
  request: { requestedBy?: string; includeAdr?: boolean; adrTitle?: string; now?: Date } = {}
): { status: "accepted" | "already_scheduled"; jobId: string } | undefined {
  if (document.type === "prd") {
    return fixture.workflow.requestDownstreamRouting(document.sourceKey, request);
  }

  if (document.type === "hld" || document.type === "lld") {
    return fixture.workflow.requestDocumentFanOut(document.sourceKey, request);
  }

  if (document.type === "spec") {
    return fixture.workflow.requestImplementationStart(document.sourceKey, request);
  }

  return undefined;
}

function latestArtifacts<T extends { type: string; location: string; url?: string }>(artifacts: T[]): T[] {
  const byTypeAndLocation = new Map<string, T>();

  for (const artifact of artifacts) {
    byTypeAndLocation.set(`${artifact.type}:${artifact.location}`, artifact);
  }

  return Array.from(byTypeAndLocation.values());
}

function approvalGateForDocumentState(
  document: Document,
  externalStatus: string | null,
  status: string
): Record<string, unknown> {
  return {
    id: `gate_${document.id}`,
    documentId: document.id,
    source: "jira",
    sourceOfTruth: prdConfirmationWorkflowPolicy.approvalSource,
    action: prdConfirmationWorkflowPolicy.approvalAction,
    approvalRole: prdConfirmationWorkflowPolicy.approvalRoles[document.type],
    transition: prdConfirmationWorkflowPolicy.approvalTransition,
    downstreamStart: prdConfirmationWorkflowPolicy.downstreamStart,
    externalIssueKey: document.sourceKey,
    externalStatus,
    status
  };
}

function approvalStatusFor(workItemState: string | undefined, externalStatus: string | undefined): string {
  if (workItemState === "approved" || externalStatus === "approved") {
    return "approved";
  }

  if (workItemState === "needs_revision" || externalStatus === "needs_revision" || externalStatus === "rejected") {
    return "needs_revision";
  }

  if (workItemState === "awaiting_approval" || externalStatus === "awaiting_approval") {
    return "pending";
  }

  return "not_ready";
}

function workItemForDocument(fixture: LegacyPrdFixture, document: Document) {
  const workItemId = document.id.startsWith("doc_") ? document.id.slice("doc_".length) : undefined;

  return fixture.store.workItems.find((candidate) => candidate.id === workItemId);
}

function taskIdForWorkflowJob(job: WorkflowJob): string | undefined {
  return job.taskId ?? stringOrUndefined(job.input.taskId);
}

type WorkflowRunTreeEdge = {
  id: string;
  type: "workflow_task_parent" | "workflow_task_job";
  from: string;
  to: string;
};

function workflowRunTreeEdges(tasks: WorkflowTask[], jobs: WorkflowJob[]): WorkflowRunTreeEdge[] {
  const parentEdges = tasks.flatMap((task): WorkflowRunTreeEdge[] =>
    task.parentTaskId
      ? [
          {
            id: `edge_${task.parentTaskId}_${task.id}`,
            type: "workflow_task_parent",
            from: task.parentTaskId,
            to: task.id
          }
        ]
      : []
  );
  const jobEdges = jobs.flatMap((job): WorkflowRunTreeEdge[] => {
    const taskId = taskIdForWorkflowJob(job);

    return taskId
      ? [
          {
            id: `edge_${taskId}_${job.id}`,
            type: "workflow_task_job",
            from: taskId,
            to: job.id
          }
        ]
      : [];
  });

  return [...parentEdges, ...jobEdges];
}

function primaryDocumentIdForJob(
  job: { id: string; input: Record<string, unknown> },
  documents: Document[],
  tasks: WorkflowTask[] = [],
  taskId?: string
): string | undefined {
  const documentIds = new Set(documents.map((document) => document.id));
  const taskDocumentId = taskId ? tasks.find((task) => task.id === taskId)?.currentDocumentId : undefined;

  if (taskDocumentId && documentIds.has(taskDocumentId)) {
    return taskDocumentId;
  }

  const inputDocumentId = stringOrUndefined(job.input.documentId);

  if (inputDocumentId && documentIds.has(inputDocumentId)) {
    return inputDocumentId;
  }

  const sourceDocumentId = stringOrUndefined(job.input.sourceDocumentId);

  if (sourceDocumentId && documentIds.has(sourceDocumentId)) {
    return sourceDocumentId;
  }

  const producedDocument = documents.find(
    (document) => document.currentVersionId && document.currentVersionId.endsWith(job.id)
  );

  if (producedDocument) {
    return producedDocument.id;
  }

  const parentDocumentId = stringOrUndefined(job.input.parentDocumentId);

  if (parentDocumentId && documentIds.has(parentDocumentId)) {
    return parentDocumentId;
  }

  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
