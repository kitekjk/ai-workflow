import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../document-core/domain";
import { rowToArtifact, rowToDocument, rowToDocumentVersion } from "../document-core/mysql-repository";
import { fromMysqlDateTime } from "../mysql/datetime";
import { prdConfirmationWorkflowPolicy, type FeedbackItem, type FeedbackSource } from "../prd-confirmation/domain";
import type { WorkflowJob, WorkflowRun, WorkflowTask } from "../workflow-core/domain";
import { rowToWorkflowJob, rowToWorkflowTask, type MysqlDatabase } from "../workflow-core/mysql-repository";

export interface WorkflowApiReadModel {
  summarizeState(sourceKey: string): Promise<Record<string, unknown> | undefined>;
  summarizeWorkflowRun(runId: string): Promise<Record<string, unknown> | undefined>;
  summarizeWorkflowRunTree(runId: string): Promise<Record<string, unknown> | undefined>;
  summarizeDocumentCurrent(documentId: string): Promise<DocumentCurrentReadModel | undefined>;
  summarizeDocumentHistory(documentId: string): Promise<Record<string, unknown> | undefined>;
}

export interface DocumentCurrentReadModel {
  document: Document;
  policy: typeof prdConfirmationWorkflowPolicy;
  currentVersion: DocumentVersion | null;
  latestQualityResult: DocumentQualityResult | null;
  currentArtifacts: Artifact[];
  pendingFeedback: FeedbackItem[];
}

type MysqlRow = Record<string, unknown>;

export class MysqlWorkflowApiReadModel implements WorkflowApiReadModel {
  constructor(private readonly database: MysqlDatabase) {}

  async summarizeState(sourceKey: string): Promise<Record<string, unknown> | undefined> {
    const run = await this.getWorkflowRunBySourceKey(sourceKey);

    if (!run) {
      return undefined;
    }

    const [jobs, documents, latestResult] = await Promise.all([
      this.listWorkflowJobs(run.id),
      this.listDocumentsForRun(run.id),
      this.getLatestWorkflowJobResultForRun(run.id)
    ]);
    const document = documents.find((candidate) => candidate.sourceKey === sourceKey) ?? documents[0];
    const currentArtifactIds = document
      ? [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter((id): id is string => Boolean(id))
      : [];
    const [currentVersion, currentArtifacts, latestQualityResult] = document
      ? await Promise.all([
          document.currentVersionId ? this.getDocumentVersion(document.currentVersionId) : Promise.resolve(undefined),
          currentArtifactIds.length > 0 ? this.getArtifactsByIds(currentArtifactIds) : Promise.resolve([]),
          this.getLatestQualityResult(document.id)
        ])
      : [undefined, [], undefined] as const;

    return {
      runId: run.id,
      documentId: document?.id,
      prdJiraKey: sourceKey,
      prdStatus: document?.status ?? run.status,
      policy: prdConfirmationWorkflowPolicy,
      jobs: jobs.map((job) => ({
        id: job.id,
        type: job.jobType,
        jira: document?.sourceKey ?? sourceKey,
        status: job.status
      })),
      artifacts: currentArtifacts.map((artifact) => ({
        type: artifact.type,
        location: artifact.location,
        url: artifact.uri
      })),
      latestQualityResult: latestQualityResult ?? null,
      latestRevisionSummary: currentVersion?.revisionSummary ?? null,
      latestResult: latestResult?.output ?? null
    };
  }

  async summarizeWorkflowRun(runId: string): Promise<Record<string, unknown> | undefined> {
    const run = await this.getWorkflowRun(runId);

    if (!run) {
      return undefined;
    }

    const [tasks, jobs, documents] = await Promise.all([
      this.listWorkflowTasks(runId),
      this.listWorkflowJobs(runId),
      this.listDocumentsForRun(runId)
    ]);

    return {
      run,
      policy: prdConfirmationWorkflowPolicy,
      tasks,
      jobs,
      documents
    };
  }

  async summarizeWorkflowRunTree(runId: string): Promise<Record<string, unknown> | undefined> {
    const summary = await this.summarizeWorkflowRun(runId);

    if (!summary) {
      return undefined;
    }

    const jobs = summary.jobs as WorkflowJob[];
    const documents = summary.documents as Document[];
    const tasks = summary.tasks as WorkflowTask[] | undefined;

    return {
      run: summary.run,
      policy: prdConfirmationWorkflowPolicy,
      tasks: tasks ?? [],
      nodes: [
        ...(tasks ?? []).map((task) => ({
          id: task.id,
          type: "workflow_task",
          taskType: task.taskType,
          status: task.status,
          currentDocumentId: task.currentDocumentId
        })),
        ...jobs.map((job) => ({
          id: job.id,
          type: "workflow_job",
          jobType: job.jobType,
          status: job.status,
          taskId: job.taskId,
          primaryDocumentId: primaryDocumentIdForJob(job, documents)
        }))
      ],
      documents
    };
  }

  async summarizeDocumentCurrent(documentId: string): Promise<DocumentCurrentReadModel | undefined> {
    const document = await this.getDocument(documentId);

    if (!document) {
      return undefined;
    }

    const currentArtifactIds = [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter(
      (id): id is string => Boolean(id)
    );
    const [currentVersion, currentArtifacts, latestQualityResult, pendingFeedback] = await Promise.all([
      document.currentVersionId ? this.getDocumentVersion(document.currentVersionId) : Promise.resolve(undefined),
      currentArtifactIds.length > 0 ? this.getArtifactsByIds(currentArtifactIds) : Promise.resolve([]),
      this.getLatestQualityResult(documentId),
      this.listPendingFeedback(documentId)
    ]);

    return {
      document,
      policy: prdConfirmationWorkflowPolicy,
      currentVersion: currentVersion ?? null,
      latestQualityResult: latestQualityResult ?? null,
      currentArtifacts,
      pendingFeedback
    };
  }

  async summarizeDocumentHistory(documentId: string): Promise<Record<string, unknown> | undefined> {
    const document = await this.getDocument(documentId);

    if (!document) {
      return undefined;
    }

    const [versions, qualityResults, artifacts, feedbackItems] = await Promise.all([
      this.listDocumentVersions(documentId),
      this.listQualityResults(documentId),
      this.listArtifacts(documentId),
      this.listFeedbackItems(documentId)
    ]);

    return {
      documentId,
      policy: prdConfirmationWorkflowPolicy,
      versions,
      qualityResults,
      artifacts,
      feedbackItems
    };
  }

  private async getWorkflowRun(runId: string): Promise<WorkflowRun | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(`SELECT * FROM workflow_run WHERE id = ?`, [runId]);

    return rows[0] ? rowToWorkflowRun(rows[0]) : undefined;
  }

  private async getWorkflowRunBySourceKey(sourceKey: string): Promise<WorkflowRun | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM workflow_run
       WHERE source_key = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sourceKey]
    );

    return rows[0] ? rowToWorkflowRun(rows[0]) : undefined;
  }

  private async listWorkflowJobs(runId: string): Promise<WorkflowJob[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM workflow_job
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
      [runId]
    );

    return rows.map(rowToWorkflowJob);
  }

  private async listWorkflowTasks(runId: string): Promise<WorkflowTask[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM workflow_task
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
      [runId]
    );

    return rows.map(rowToWorkflowTask);
  }

  private async getLatestWorkflowJobResultForRun(runId: string): Promise<{ output: Record<string, unknown> } | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT result.output_json
       FROM workflow_job_result result
       INNER JOIN workflow_job job ON job.id = result.job_id
       WHERE job.run_id = ?
       ORDER BY result.created_at DESC, result.id DESC
       LIMIT 1`,
      [runId]
    );

    const output = rows[0]?.output_json;

    return output === undefined ? undefined : { output: parseJsonRecord(output) };
  }

  private async listDocumentsForRun(runId: string): Promise<Document[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM document
       WHERE workflow_run_id = ?
       ORDER BY created_at ASC, id ASC`,
      [runId]
    );

    return rows.map(rowToDocument);
  }

  private async getDocument(documentId: string): Promise<Document | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(`SELECT * FROM document WHERE id = ?`, [documentId]);

    return rows[0] ? rowToDocument(rows[0]) : undefined;
  }

  private async getDocumentVersion(versionId: string): Promise<DocumentVersion | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(`SELECT * FROM document_version WHERE id = ?`, [versionId]);

    return rows[0] ? rowToDocumentVersion(rows[0]) : undefined;
  }

  private async listDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM document_version
       WHERE document_id = ?
       ORDER BY version ASC, id ASC`,
      [documentId]
    );

    return rows.map(rowToDocumentVersion);
  }

  private async getArtifactsByIds(artifactIds: string[]): Promise<Artifact[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM artifact
       WHERE id IN (${placeholders(artifactIds)})`,
      artifactIds
    );
    const artifactsById = new Map(rows.map((row) => [String(row.id), rowToArtifact(row)]));

    return artifactIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  }

  private async listArtifacts(documentId: string): Promise<Artifact[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM artifact
       WHERE document_id = ?
       ORDER BY created_at ASC, id ASC`,
      [documentId]
    );

    return rows.map(rowToArtifact);
  }

  private async getLatestQualityResult(documentId: string): Promise<DocumentQualityResult | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM quality_gate_result
       WHERE document_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [documentId]
    );

    return rows[0] ? rowToQualityResult(rows[0]) : undefined;
  }

  private async listQualityResults(documentId: string): Promise<DocumentQualityResult[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM quality_gate_result
       WHERE document_id = ?
       ORDER BY created_at ASC, id ASC`,
      [documentId]
    );

    return rows.map(rowToQualityResult);
  }

  private async listPendingFeedback(documentId: string): Promise<FeedbackItem[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM feedback_item
       WHERE document_id = ?
         AND revision_job_id IS NULL
       ORDER BY created_at ASC, id ASC`,
      [documentId]
    );

    return rows.map(rowToFeedbackItem);
  }

  private async listFeedbackItems(documentId: string): Promise<FeedbackItem[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT *
       FROM feedback_item
       WHERE document_id = ?
       ORDER BY created_at ASC, id ASC`,
      [documentId]
    );

    return rows.map(rowToFeedbackItem);
  }
}

function primaryDocumentIdForJob(job: WorkflowJob, documents: Document[]): string | undefined {
  const sourceDocumentId = stringOrUndefined(job.input.sourceDocumentId);

  if (sourceDocumentId && documents.some((document) => document.id === sourceDocumentId)) {
    return sourceDocumentId;
  }

  const producedDocument = documents.find((document) => document.currentVersionId && document.currentVersionId.endsWith(job.id));

  if (producedDocument) {
    return producedDocument.id;
  }

  const parentDocumentId = stringOrUndefined(job.input.parentDocumentId);

  if (parentDocumentId && documents.some((document) => document.id === parentDocumentId)) {
    return parentDocumentId;
  }

  return documents[0]?.id;
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

function rowToQualityResult(row: MysqlRow): DocumentQualityResult {
  return {
    id: stringValue(row.id),
    documentId: stringValue(row.document_id),
    documentVersionId: optionalString(row.document_version_id),
    evaluatorJobId: stringValue(row.workflow_job_id),
    status: stringValue(row.status) as DocumentQualityResult["status"],
    score: optionalNumber(row.score),
    summary: optionalString(row.summary),
    missingInformation: parseJsonStringArray(row.missing_information_json),
    clarificationQuestions: parseJsonStringArray(row.clarification_questions_json),
    riskItems: parseJsonStringArray(row.risk_items_json),
    qualityFailureAction: optionalQualityFailureAction(row.quality_failure_action),
    autoRevisionScheduled: Boolean(row.auto_revision_scheduled),
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

function optionalQualityFailureAction(
  value: unknown
): DocumentQualityResult["qualityFailureAction"] | undefined {
  return value === "human_clarification" || value === "auto_rewrite" || value === "manual_or_auto"
    ? value
    : undefined;
}

function feedbackSourceFor(value: unknown): FeedbackSource {
  return value === "app" || value === "jira" || value === "wiki" || value === "github" ? value : "app";
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error("Cannot create SQL placeholder list for empty values");
  }

  return values.map(() => "?").join(", ");
}

function parseJsonStringArray(value: unknown): string[] {
  const parsed = parseJson(value);

  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value);
  }

  return value;
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

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "number" ? value : Number(value);
}

function isoValue(value: unknown): string {
  if (value instanceof Date) {
    return fromMysqlDateTime(value);
  }

  if (typeof value === "string") {
    return fromMysqlDateTime(value);
  }

  return stringValue(value);
}
