import type { Artifact as DocumentArtifact, Document, DocumentVersion } from "../../document-core/domain";
import { rowToArtifact, rowToDocument, rowToDocumentVersion } from "../../document-core/mysql-repository";
import type { WorkflowJob, WorkflowJobResult, WorkflowRun } from "../../workflow-core/domain";
import { rowToWorkflowJob, type MysqlDatabase } from "../../workflow-core/mysql-repository";
import type {
  AgentJob,
  AgentJobResult,
  Artifact,
  DocumentArtifactType,
  ExternalIssue,
  FeedbackItem,
  FeedbackSource,
  JobType,
  PrdConfirmationStore,
  WorkItem,
  WorkItemJiraLink
} from "./domain";

export interface PrdSnapshotLoadResult {
  restored: boolean;
  workflowRuns: number;
  workItems: number;
  jobs: number;
  jobResults: number;
  artifacts: number;
  feedbackItems: number;
}

export interface PrdSnapshotLoader {
  loadInto(store: PrdConfirmationStore): Promise<PrdSnapshotLoadResult>;
}

type MysqlRow = Record<string, unknown>;

export class MysqlPrdSnapshotLoader implements PrdSnapshotLoader {
  constructor(private readonly database: MysqlDatabase) {}

  async loadInto(store: PrdConfirmationStore): Promise<PrdSnapshotLoadResult> {
    const workflowRuns = await this.selectWorkflowRuns();

    if (workflowRuns.length === 0) {
      return emptyLoadResult();
    }

    const runIds = workflowRuns.map((run) => run.id);
    const documents = await this.selectDocuments(runIds);

    if (documents.length === 0) {
      return emptyLoadResult({ workflowRuns: workflowRuns.length });
    }

    const documentIds = documents.map((document) => document.id);
    const [documentVersions, workflowJobs, workflowJobResults, documentArtifacts, feedbackItems] =
      await Promise.all([
        this.selectDocumentVersions(documentIds),
        this.selectWorkflowJobs(runIds),
        this.selectWorkflowJobResults(runIds),
        this.selectArtifacts(documentIds),
        this.selectFeedbackItems(documentIds)
      ]);
    const restored = restoreStoreFromSnapshot(store, {
      workflowRuns,
      workflowJobs,
      workflowJobResults,
      documents,
      documentVersions,
      documentArtifacts,
      feedbackItems
    });

    return {
      restored: true,
      workflowRuns: workflowRuns.length,
      workItems: restored.workItems,
      jobs: restored.jobs,
      jobResults: restored.jobResults,
      artifacts: restored.artifacts,
      feedbackItems: restored.feedbackItems
    };
  }

  private async selectWorkflowRuns(): Promise<WorkflowRun[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM workflow_run
       WHERE workflow_definition_id = ?
       ORDER BY created_at ASC, id ASC`,
      ["prd_confirmation"]
    );

    return rows.map(rowToWorkflowRun);
  }

  private async selectDocuments(runIds: string[]): Promise<Document[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM document
       WHERE workflow_run_id IN (${placeholders(runIds)})
       ORDER BY created_at ASC, id ASC`,
      runIds
    );

    return rows.map(rowToDocument);
  }

  private async selectDocumentVersions(documentIds: string[]): Promise<DocumentVersion[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM document_version
       WHERE document_id IN (${placeholders(documentIds)})
       ORDER BY created_at ASC, version ASC, id ASC`,
      documentIds
    );

    return rows.map(rowToDocumentVersion);
  }

  private async selectWorkflowJobs(runIds: string[]): Promise<WorkflowJob[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM workflow_job
       WHERE run_id IN (${placeholders(runIds)})
       ORDER BY created_at ASC, id ASC`,
      runIds
    );

    return rows.map(rowToWorkflowJob);
  }

  private async selectWorkflowJobResults(runIds: string[]): Promise<WorkflowJobResult[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT workflow_job_result.*
       FROM workflow_job_result
       INNER JOIN workflow_job ON workflow_job.id = workflow_job_result.job_id
       WHERE workflow_job.run_id IN (${placeholders(runIds)})
       ORDER BY workflow_job_result.created_at ASC, workflow_job_result.attempt_no ASC, workflow_job_result.id ASC`,
      runIds
    );

    return rows.map(rowToWorkflowJobResult);
  }

  private async selectArtifacts(documentIds: string[]): Promise<DocumentArtifact[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM artifact
       WHERE document_id IN (${placeholders(documentIds)})
       ORDER BY created_at ASC, id ASC`,
      documentIds
    );

    return rows.map(rowToArtifact);
  }

  private async selectFeedbackItems(documentIds: string[]): Promise<FeedbackItem[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM feedback_item
       WHERE document_id IN (${placeholders(documentIds)})
       ORDER BY created_at ASC, id ASC`,
      documentIds
    );

    return rows.map(rowToFeedbackItem);
  }
}

function restoreStoreFromSnapshot(
  store: PrdConfirmationStore,
  snapshot: {
    workflowRuns: WorkflowRun[];
    workflowJobs: WorkflowJob[];
    workflowJobResults: WorkflowJobResult[];
    documents: Document[];
    documentVersions: DocumentVersion[];
    documentArtifacts: DocumentArtifact[];
    feedbackItems: FeedbackItem[];
  }
): { workItems: number; jobs: number; jobResults: number; artifacts: number; feedbackItems: number } {
  const existingExternalIssues: Map<string, ExternalIssue> = new Map(store.externalIssues);
  const documentsById = new Map(snapshot.documents.map((document) => [document.id, document]));
  const versionsByProducerJobId = new Map(
    snapshot.documentVersions.map((version) => [version.producerJobId, version])
  );
  const artifactsByProducerJobId = new Map(
    snapshot.documentArtifacts
      .filter((artifact) => artifact.documentId)
      .map((artifact) => [artifact.producerJobId, artifact])
  );
  const workItems = snapshot.documents.map((document) => toWorkItem(document));
  const workItemsByDocumentId = new Map(
    snapshot.documents.map((document, index) => [document.id, workItems[index]])
  );
  const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem]));
  const agentJobs = snapshot.workflowJobs
    .map((job) =>
      toAgentJob(job, {
        documentsById,
        versionsByProducerJobId,
        artifactsByProducerJobId,
        workItemsByDocumentId,
        firstWorkItemForRun: firstWorkItemForRun(workItems)
      })
    )
    .filter((job): job is AgentJob => Boolean(job));
  const agentJobsById = new Map(agentJobs.map((job) => [job.id, job]));
  const agentJobResults = snapshot.workflowJobResults
    .map((result) => toAgentJobResult(result, agentJobsById))
    .filter((result): result is AgentJobResult => Boolean(result));
  const artifacts = snapshot.documentArtifacts
    .map((artifact) => toLegacyArtifact(artifact, documentsById))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const workItemJiraLinks = toWorkItemJiraLinks(workItems, existingExternalIssues);

  for (const workItem of workItems) {
    restoreImplementationState(workItem, agentJobs, agentJobResults);
    restoreExternalIssue(store, workItem, existingExternalIssues);
  }

  store.workItems = workItems;
  store.workItemJiraLinks = workItemJiraLinks;
  store.agentJobs = agentJobs;
  store.agentJobResults = agentJobResults;
  store.artifacts = artifacts;
  store.feedbackItems = snapshot.feedbackItems.filter((feedback) => workItemsById.has(feedback.workItemId));

  return {
    workItems: store.workItems.length,
    jobs: store.agentJobs.length,
    jobResults: store.agentJobResults.length,
    artifacts: store.artifacts.length,
    feedbackItems: store.feedbackItems.length
  };
}

function toWorkItem(document: Document): WorkItem {
  return {
    id: workItemIdForDocumentId(document.id),
    runId: document.workflowRunId,
    artifactType: document.type as DocumentArtifactType,
    parentWorkItemId: document.parentDocumentId ? workItemIdForDocumentId(document.parentDocumentId) : undefined,
    primaryJiraKey: document.sourceKey,
    title: document.title,
    state: stateForDocument(document)
  };
}

function toAgentJob(
  job: WorkflowJob,
  context: {
    documentsById: Map<string, Document>;
    versionsByProducerJobId: Map<string, DocumentVersion>;
    artifactsByProducerJobId: Map<string, DocumentArtifact>;
    workItemsByDocumentId: Map<string, WorkItem>;
    firstWorkItemForRun: Map<string, WorkItem>;
  }
): AgentJob | undefined {
  const jobType = knownJobType(job.jobType);

  if (!jobType) {
    return undefined;
  }

  const documentId = documentIdForJob(job, context);
  const workItem = documentId ? context.workItemsByDocumentId.get(documentId) : context.firstWorkItemForRun.get(job.runId);

  if (!workItem) {
    return undefined;
  }

  return {
    id: job.id,
    workItemId: workItem.id,
    jobType,
    primaryJiraKey: workItem.primaryJiraKey,
    status: legacyJobStatusFor(job.status),
    input: job.input
  };
}

function toAgentJobResult(
  result: WorkflowJobResult,
  agentJobsById: Map<string, AgentJob>
): AgentJobResult | undefined {
  const job = agentJobsById.get(result.jobId);

  if (!job) {
    return undefined;
  }

  return {
    jobId: result.jobId,
    jobType: job.jobType,
    primaryJiraKey: job.primaryJiraKey,
    output: result.output,
    processed: true
  };
}

function toLegacyArtifact(artifact: DocumentArtifact, documentsById: Map<string, Document>): Artifact | undefined {
  const document = artifact.documentId ? documentsById.get(artifact.documentId) : undefined;
  const type = legacyArtifactTypeFor(artifact, document);

  if (!type) {
    return undefined;
  }

  return {
    jobId: artifact.producerJobId,
    type,
    location: legacyArtifactLocationFor(artifact.location),
    url: artifact.uri,
    externalId: artifact.externalId,
    externalVersion: artifact.externalVersion,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt
  };
}

function toWorkItemJiraLinks(
  workItems: WorkItem[],
  existingExternalIssues: Map<string, ExternalIssue>
): WorkItemJiraLink[] {
  const links: WorkItemJiraLink[] = [];

  for (const workItem of workItems) {
    links.push({ workItemId: workItem.id, jiraKey: workItem.primaryJiraKey, role: "primary" });

    if (workItem.artifactType !== "prd") {
      continue;
    }

    const linkedSourceKeys = existingExternalIssues.get(workItem.primaryJiraKey)?.linkedSourceKeys ?? [];

    for (const sourceKey of linkedSourceKeys) {
      links.push({ workItemId: workItem.id, jiraKey: sourceKey, role: "source_request" });
    }
  }

  return links;
}

function restoreImplementationState(
  workItem: WorkItem,
  jobs: AgentJob[],
  results: AgentJobResult[]
): void {
  if (workItem.artifactType !== "spec" || workItem.state !== "approved") {
    return;
  }

  const workItemJobs = jobs.filter((job) => job.workItemId === workItem.id);
  const collectStatusJob = findLast(workItemJobs, (job) => job.jobType === "implementation.collect_pr_status");
  const collectStatusResult = collectStatusJob
    ? findLast(results, (result) => result.jobId === collectStatusJob.id)
    : undefined;

  if (collectStatusResult) {
    const reviewStatus = stringOrUndefined(collectStatusResult.output.reviewStatus);
    const ciStatus = stringOrUndefined(collectStatusResult.output.ciStatus);
    if (collectStatusResult.output.merged === true) {
      workItem.state = "implementation_merged";
    } else {
      workItem.state = reviewStatus === "approved" && ciStatus === "success"
        ? "implementation_reviewed"
        : "implementation_in_review";
    }
    return;
  }

  const openPrJob = findLast(workItemJobs, (job) => job.jobType === "implementation.open_pr");
  const openPrResult = openPrJob ? findLast(results, (result) => result.jobId === openPrJob.id) : undefined;

  if (openPrResult || openPrJob?.status === "running" || openPrJob?.status === "succeeded") {
    workItem.state = "implementation_pr_open";
  }
}

function restoreExternalIssue(
  store: PrdConfirmationStore,
  workItem: WorkItem,
  existingExternalIssues: Map<string, ExternalIssue>
): void {
  const existing = existingExternalIssues.get(workItem.primaryJiraKey);

  store.externalIssues.set(workItem.primaryJiraKey, {
    key: workItem.primaryJiraKey,
    issueType: "prd",
    status: externalIssueStatusFor(workItem.state),
    summary: workItem.title ?? existing?.summary ?? workItem.primaryJiraKey,
    description: existing?.description,
    linkedSourceKeys: existing?.linkedSourceKeys
  });
}

function documentIdForJob(
  job: WorkflowJob,
  context: {
    documentsById: Map<string, Document>;
    versionsByProducerJobId: Map<string, DocumentVersion>;
    artifactsByProducerJobId: Map<string, DocumentArtifact>;
  }
): string | undefined {
  const sourceDocumentId = stringOrUndefined(job.input.sourceDocumentId);

  if (sourceDocumentId && context.documentsById.has(sourceDocumentId)) {
    return sourceDocumentId;
  }

  const documentId = stringOrUndefined(job.input.documentId);

  if (documentId && context.documentsById.has(documentId)) {
    return documentId;
  }

  const producedVersionDocumentId = context.versionsByProducerJobId.get(job.id)?.documentId;

  if (producedVersionDocumentId && context.documentsById.has(producedVersionDocumentId)) {
    return producedVersionDocumentId;
  }

  const artifactDocumentId = context.artifactsByProducerJobId.get(job.id)?.documentId;

  if (artifactDocumentId && context.documentsById.has(artifactDocumentId)) {
    return artifactDocumentId;
  }

  const parentDocumentId = stringOrUndefined(job.input.parentDocumentId);

  return parentDocumentId && context.documentsById.has(parentDocumentId) ? parentDocumentId : undefined;
}

function firstWorkItemForRun(workItems: WorkItem[]): Map<string, WorkItem> {
  const byRun = new Map<string, WorkItem>();

  for (const workItem of workItems) {
    if (!byRun.has(workItem.runId)) {
      byRun.set(workItem.runId, workItem);
    }
  }

  return byRun;
}

function stateForDocument(document: Document): string {
  if (document.status === "needs_revision") {
    return "needs_revision";
  }

  if (document.status === "approval_pending") {
    return "awaiting_approval";
  }

  if (document.status === "approved") {
    return "approved";
  }

  if (document.status === "quality_review") {
    return "evaluating";
  }

  if (document.status === "canceled") {
    return "failed";
  }

  return "draft_requested";
}

function externalIssueStatusFor(workItemState: string): string {
  if (workItemState === "awaiting_approval") {
    return "awaiting_approval";
  }

  if (workItemState === "approved" || workItemState.startsWith("implementation_")) {
    return "approved";
  }

  if (workItemState === "needs_revision") {
    return "needs_revision";
  }

  if (workItemState === "evaluating") {
    return "evaluating";
  }

  if (workItemState === "failed") {
    return "failed";
  }

  return "drafting";
}

function legacyJobStatusFor(status: WorkflowJob["status"]): AgentJob["status"] {
  if (status === "pending" || status === "retrying") {
    return "pending";
  }

  if (status === "claimed" || status === "cancel_requested") {
    return "claimed";
  }

  if (status === "running") {
    return "running";
  }

  if (status === "succeeded") {
    return "succeeded";
  }

  return "failed";
}

function knownJobType(jobType: string): JobType | undefined {
  return jobType === "prd.generate_draft" ||
    jobType === "prd.evaluate_quality" ||
    jobType === "prd.apply_feedback_revision" ||
    jobType === "prd.route_downstream" ||
    jobType === "document.generate" ||
    jobType === "document.evaluate" ||
    jobType === "document.revise" ||
    jobType === "document.fan_out" ||
    jobType === "implementation.open_pr" ||
    jobType === "implementation.update_pr" ||
    jobType === "implementation.collect_pr_status"
    ? jobType
    : undefined;
}

function legacyArtifactTypeFor(
  artifact: DocumentArtifact,
  document: Document | undefined
): Artifact["type"] | undefined {
  const legacyType = stringOrUndefined(artifact.metadata.legacyType);

  if (
    legacyType === "prd_markdown" ||
    legacyType === "prd_wiki_page" ||
    legacyType === "document_markdown" ||
    legacyType === "document_wiki_page" ||
    legacyType === "pull_request"
  ) {
    return legacyType;
  }

  if (artifact.type === "document_markdown") {
    return document?.type === "prd" ? "prd_markdown" : "document_markdown";
  }

  if (artifact.type === "wiki_page") {
    return document?.type === "prd" ? "prd_wiki_page" : "document_wiki_page";
  }

  if (artifact.type === "pull_request") {
    return "pull_request";
  }

  return undefined;
}

function legacyArtifactLocationFor(location: DocumentArtifact["location"]): Artifact["location"] {
  if (location === "git" || location === "wiki" || location === "external") {
    return location;
  }

  return "external";
}

function workItemIdForDocumentId(documentId: string): string {
  return documentId.startsWith("doc_") ? documentId.slice("doc_".length) : documentId;
}

function rowToWorkflowRun(row: MysqlRow): WorkflowRun {
  return {
    id: stringValue(row.id),
    workflowDefinitionId: stringValue(row.workflow_definition_id),
    status: stringValue(row.status) as WorkflowRun["status"],
    sourceType: stringValue(row.source_type) as WorkflowRun["sourceType"],
    sourceKey: stringValue(row.source_key),
    outputLanguage: stringValue(row.output_language),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at)
  };
}

function rowToWorkflowJobResult(row: MysqlRow): WorkflowJobResult {
  return {
    id: stringValue(row.id),
    jobId: stringValue(row.job_id),
    runnerId: optionalString(row.runner_id),
    attemptNo: numberValue(row.attempt_no),
    status: stringValue(row.status) as WorkflowJobResult["status"],
    output: parseJsonRecord(row.output_json),
    errorCode: optionalString(row.error_code),
    errorMessage: optionalString(row.error_message),
    createdAt: isoValue(row.created_at)
  };
}

function rowToFeedbackItem(row: MysqlRow): FeedbackItem {
  return {
    id: stringValue(row.id),
    documentId: stringValue(row.document_id),
    workItemId: stringValue(row.work_item_id),
    source: feedbackSourceFor(row.source),
    author: optionalString(row.author),
    body: stringValue(row.body),
    externalId: optionalString(row.external_id),
    externalUrl: optionalString(row.external_url),
    metadata: parseJsonRecord(row.metadata_json),
    revisionJobId: optionalString(row.revision_job_id),
    createdAt: isoValue(row.created_at)
  };
}

function feedbackSourceFor(value: unknown): FeedbackSource {
  return value === "app" || value === "jira" || value === "wiki" || value === "github" ? value : "app";
}

function emptyLoadResult(partial: Partial<PrdSnapshotLoadResult> = {}): PrdSnapshotLoadResult {
  return {
    restored: false,
    workflowRuns: 0,
    workItems: 0,
    jobs: 0,
    jobResults: 0,
    artifacts: 0,
    feedbackItems: 0,
    ...partial
  };
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error("Cannot create SQL placeholder list for empty values");
  }

  return values.map(() => "?").join(", ");
}

function findLast<T>(values: T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];

    if (predicate(value)) {
      return value;
    }
  }

  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string database value, got: ${String(value)}`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function isoValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return stringValue(value);
}
