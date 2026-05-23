import { randomUUID } from "node:crypto";
import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../document-core/domain";
import { toMysqlDateTime, toNullableMysqlDateTime } from "../mysql/datetime";
import type { WorkflowEvent, WorkflowJob, WorkflowJobResult, WorkflowRun, WorkflowTask } from "../workflow-core/domain";
import type { MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface WorkflowMutation {
  workflowRuns?: WorkflowRun[];
  workflowTasks?: WorkflowTask[];
  documentStates?: Document[];
  documents?: Document[];
  workflowJobs?: WorkflowJob[];
  jobResults?: WorkflowJobResult[];
  documentVersions?: DocumentVersion[];
  artifacts?: Artifact[];
  documentCurrentPointers?: WorkflowDocumentCurrentPointer[];
  qualityResults?: DocumentQualityResult[];
  feedbackItems?: WorkflowFeedbackItem[];
  documentEvents?: WorkflowDocumentMutationEvent[];
  events?: WorkflowMutationEvent[];
  /** Stage-lifecycle events (task.stage_entered / task.stage_exited) emitted in
   * parallel with the legacy workflow.engine_transition event.  Stored in the
   * same workflow_event table; kept separate so existing oracle assertions on
   * the `events` array are unaffected during this transition slice. */
  stageEvents?: WorkflowMutationEvent[];
}

export type WorkflowMutationEvent = Omit<WorkflowEvent, "id">;

export interface WorkflowDocumentMutationEvent {
  documentId: string;
  jobId?: string;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowFeedbackItem {
  id: string;
  workItemId: string;
  documentId: string;
  source: string;
  author?: string;
  body: string;
  createdAt: string;
  externalId?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
  revisionJobId?: string;
}

export interface WorkflowDocumentCurrentPointer {
  id: string;
  status: Document["status"];
  currentVersionId?: string;
  currentMarkdownArtifactId?: string;
  currentWikiArtifactId?: string;
  updatedAt: string;
}

export interface WorkflowMutationApplier {
  apply(mutation: WorkflowMutation): Promise<void>;
}

export interface MysqlWorkflowMutationApplierOptions {
  idGenerator?: (prefix: string) => string;
}

export class MysqlWorkflowMutationApplier implements WorkflowMutationApplier {
  private readonly idGenerator: (prefix: string) => string;

  constructor(
    private readonly database: MysqlDatabase,
    options: MysqlWorkflowMutationApplierOptions = {}
  ) {
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async apply(mutation: WorkflowMutation): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();

      for (const run of mutation.workflowRuns ?? []) {
        await upsertWorkflowRun(connection, run);
      }

      for (const task of mutation.workflowTasks ?? []) {
        await upsertWorkflowTask(connection, task);
      }

      for (const document of mutation.documentStates ?? []) {
        await upsertDocumentState(connection, document);
      }

      for (const document of mutation.documents ?? []) {
        await upsertDocument(connection, document);
      }

      for (const job of mutation.workflowJobs ?? []) {
        await upsertWorkflowJob(connection, job);
      }

      for (const result of mutation.jobResults ?? []) {
        await upsertWorkflowJobResult(connection, result);
      }

      for (const version of mutation.documentVersions ?? []) {
        await upsertDocumentVersion(connection, version);
      }

      for (const artifact of mutation.artifacts ?? []) {
        await upsertArtifact(connection, artifact);
      }

      for (const document of mutation.documentCurrentPointers ?? []) {
        await updateDocumentCurrentPointers(connection, document);
      }

      for (const qualityResult of mutation.qualityResults ?? []) {
        await upsertQualityResult(connection, qualityResult);
      }

      for (const feedback of mutation.feedbackItems ?? []) {
        await upsertFeedbackItem(connection, feedback);
      }

      for (const event of mutation.documentEvents ?? []) {
        await insertDocumentWorkflowEvent(connection, event, this.idGenerator);
      }

      for (const event of mutation.events ?? []) {
        await insertWorkflowEvent(connection, event, this.idGenerator);
      }

      for (const event of mutation.stageEvents ?? []) {
        await insertWorkflowEvent(connection, event, this.idGenerator);
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function upsertWorkflowRun(executor: MysqlQueryExecutor, run: WorkflowRun): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_run (
      id, workflow_definition_id, status, source_type, source_key, output_language, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      source_type = VALUES(source_type),
      source_key = VALUES(source_key),
      output_language = VALUES(output_language),
      updated_at = VALUES(updated_at)`,
    [
      run.id,
      run.workflowDefinitionId,
      run.status,
      run.sourceType,
      run.sourceKey,
      run.outputLanguage,
      toMysqlDateTime(run.createdAt),
      toMysqlDateTime(run.updatedAt)
    ]
  );
}

async function upsertWorkflowTask(executor: MysqlQueryExecutor, task: WorkflowTask): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_task (
      id, run_id, parent_task_id, task_type, source_key, title, status,
      current_document_id, definition_id, definition_version, current_stage_id,
      stage_attempt_counts_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      parent_task_id = COALESCE(VALUES(parent_task_id), parent_task_id),
      task_type = VALUES(task_type),
      source_key = VALUES(source_key),
      title = VALUES(title),
      status = VALUES(status),
      current_document_id = VALUES(current_document_id),
      definition_id = VALUES(definition_id),
      definition_version = VALUES(definition_version),
      current_stage_id = VALUES(current_stage_id),
      stage_attempt_counts_json = VALUES(stage_attempt_counts_json),
      metadata_json = VALUES(metadata_json),
      updated_at = VALUES(updated_at)`,
    [
      task.id,
      task.runId,
      task.parentTaskId ?? null,
      task.taskType,
      task.sourceKey,
      task.title,
      task.status,
      task.currentDocumentId ?? null,
      task.definitionId ?? null,
      task.definitionVersion ?? null,
      task.currentStageId ?? null,
      task.stageAttemptCounts !== undefined ? JSON.stringify(task.stageAttemptCounts) : null,
      JSON.stringify(task.metadata),
      toMysqlDateTime(task.createdAt),
      toMysqlDateTime(task.updatedAt)
    ]
  );
}

async function upsertDocument(executor: MysqlQueryExecutor, document: Document): Promise<void> {
  await executor.execute(
    `INSERT INTO document (
      id, workflow_run_id, workflow_task_id, parent_document_id, type, source_key, title, status,
      current_version_id, current_markdown_artifact_id, current_wiki_artifact_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      workflow_task_id = VALUES(workflow_task_id),
      parent_document_id = VALUES(parent_document_id),
      type = VALUES(type),
      source_key = VALUES(source_key),
      title = VALUES(title),
      status = VALUES(status),
      current_version_id = VALUES(current_version_id),
      current_markdown_artifact_id = VALUES(current_markdown_artifact_id),
      current_wiki_artifact_id = VALUES(current_wiki_artifact_id),
      updated_at = VALUES(updated_at)`,
    [
      document.id,
      document.workflowRunId,
      document.workflowTaskId ?? null,
      document.parentDocumentId ?? null,
      document.type,
      document.sourceKey,
      document.title,
      document.status,
      document.currentVersionId ?? null,
      document.currentMarkdownArtifactId ?? null,
      document.currentWikiArtifactId ?? null,
      toMysqlDateTime(document.createdAt),
      toMysqlDateTime(document.updatedAt)
    ]
  );
}

async function upsertDocumentState(executor: MysqlQueryExecutor, document: Document): Promise<void> {
  await executor.execute(
    `INSERT INTO document (
      id, workflow_run_id, workflow_task_id, parent_document_id, type, source_key, title, status,
      current_version_id, current_markdown_artifact_id, current_wiki_artifact_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      workflow_task_id = COALESCE(VALUES(workflow_task_id), workflow_task_id),
      parent_document_id = VALUES(parent_document_id),
      type = VALUES(type),
      source_key = VALUES(source_key),
      title = VALUES(title),
      status = VALUES(status),
      updated_at = VALUES(updated_at)`,
    [
      document.id,
      document.workflowRunId,
      document.workflowTaskId ?? null,
      document.parentDocumentId ?? null,
      document.type,
      document.sourceKey,
      document.title,
      document.status,
      toMysqlDateTime(document.createdAt),
      toMysqlDateTime(document.updatedAt)
    ]
  );
}

async function upsertWorkflowJob(executor: MysqlQueryExecutor, job: WorkflowJob): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_job (
      id, run_id, task_id, job_type, status, input_json, priority, project_id, repository_id,
      assigned_user_id, assigned_team_id, required_role, required_capabilities_json,
      preferred_engine, required_engine, execution_policy, assigned_runner_id,
      claimed_by_runner_id, claimed_at, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      task_id = VALUES(task_id),
      job_type = VALUES(job_type),
      status = VALUES(status),
      input_json = VALUES(input_json),
      priority = VALUES(priority),
      project_id = VALUES(project_id),
      repository_id = VALUES(repository_id),
      assigned_user_id = VALUES(assigned_user_id),
      assigned_team_id = VALUES(assigned_team_id),
      required_role = VALUES(required_role),
      required_capabilities_json = VALUES(required_capabilities_json),
      preferred_engine = VALUES(preferred_engine),
      required_engine = VALUES(required_engine),
      execution_policy = VALUES(execution_policy),
      assigned_runner_id = VALUES(assigned_runner_id),
      claimed_by_runner_id = VALUES(claimed_by_runner_id),
      claimed_at = VALUES(claimed_at),
      lease_expires_at = VALUES(lease_expires_at),
      updated_at = VALUES(updated_at)`,
    [
      job.id,
      job.runId,
      job.taskId ?? null,
      job.jobType,
      job.status,
      JSON.stringify(job.input),
      job.priority,
      job.projectId ?? null,
      job.repositoryId ?? null,
      job.assignedUserId ?? null,
      job.assignedTeamId ?? null,
      job.requiredRole ?? null,
      JSON.stringify(job.requiredCapabilities),
      job.preferredEngine ?? null,
      job.requiredEngine ?? null,
      job.executionPolicy,
      job.assignedRunnerId ?? null,
      job.claimedByRunnerId ?? null,
      toNullableMysqlDateTime(job.claimedAt),
      toNullableMysqlDateTime(job.leaseExpiresAt),
      toMysqlDateTime(job.createdAt),
      toMysqlDateTime(job.updatedAt)
    ]
  );
}

async function upsertWorkflowJobResult(executor: MysqlQueryExecutor, result: WorkflowJobResult): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_job_result (
      id, job_id, runner_id, attempt_no, status, output_json, error_category, error_code, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      output_json = VALUES(output_json),
      error_category = VALUES(error_category),
      error_code = VALUES(error_code),
      error_message = VALUES(error_message)`,
    [
      result.id,
      result.jobId,
      result.runnerId ?? null,
      result.attemptNo,
      result.status,
      JSON.stringify(result.output),
      result.errorCategory ?? null,
      result.errorCode ?? null,
      result.errorMessage ?? null,
      toMysqlDateTime(result.createdAt)
    ]
  );
}

async function upsertDocumentVersion(executor: MysqlQueryExecutor, version: DocumentVersion): Promise<void> {
  await executor.execute(
    `INSERT INTO document_version (
      id, document_id, version, producer_job_id, summary, revision_summary, revision_job_id,
      content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      version = VALUES(version),
      producer_job_id = VALUES(producer_job_id),
      summary = VALUES(summary),
      revision_summary = VALUES(revision_summary),
      revision_job_id = VALUES(revision_job_id),
      content_hash = VALUES(content_hash)`,
    [
      version.id,
      version.documentId,
      version.version,
      version.producerJobId,
      version.summary ?? null,
      version.revisionSummary ?? null,
      version.revisionJobId ?? null,
      version.contentHash ?? null,
      toMysqlDateTime(version.createdAt)
    ]
  );
}

async function upsertArtifact(executor: MysqlQueryExecutor, artifact: Artifact): Promise<void> {
  await executor.execute(
    `INSERT INTO artifact (
      id, document_id, document_version_id, producer_job_id, type, location, uri,
      external_id, external_version, content_hash, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      document_id = VALUES(document_id),
      document_version_id = VALUES(document_version_id),
      producer_job_id = VALUES(producer_job_id),
      type = VALUES(type),
      location = VALUES(location),
      uri = VALUES(uri),
      external_id = VALUES(external_id),
      external_version = VALUES(external_version),
      content_hash = VALUES(content_hash),
      metadata_json = VALUES(metadata_json)`,
    [
      artifact.id,
      artifact.documentId ?? null,
      artifact.documentVersionId ?? null,
      artifact.producerJobId,
      artifact.type,
      artifact.location,
      artifact.uri,
      artifact.externalId ?? null,
      artifact.externalVersion ?? null,
      artifact.contentHash ?? null,
      JSON.stringify(artifact.metadata),
      toMysqlDateTime(artifact.createdAt)
    ]
  );
}

async function updateDocumentCurrentPointers(
  executor: MysqlQueryExecutor,
  document: WorkflowDocumentCurrentPointer
): Promise<void> {
  await executor.execute(
    `UPDATE document
     SET status = ?,
         current_version_id = ?,
         current_markdown_artifact_id = ?,
         current_wiki_artifact_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      document.status,
      document.currentVersionId ?? null,
      document.currentMarkdownArtifactId ?? null,
      document.currentWikiArtifactId ?? null,
      toMysqlDateTime(document.updatedAt),
      document.id
    ]
  );
}

async function upsertQualityResult(executor: MysqlQueryExecutor, result: DocumentQualityResult): Promise<void> {
  await executor.execute(
    `INSERT INTO quality_gate_result (
      id, document_id, document_version_id, workflow_job_id, status, score, summary,
      missing_information_json, clarification_questions_json, risk_items_json,
      quality_failure_action, auto_revision_scheduled, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      document_id = VALUES(document_id),
      document_version_id = VALUES(document_version_id),
      workflow_job_id = VALUES(workflow_job_id),
      status = VALUES(status),
      score = VALUES(score),
      summary = VALUES(summary),
      missing_information_json = VALUES(missing_information_json),
      clarification_questions_json = VALUES(clarification_questions_json),
      risk_items_json = VALUES(risk_items_json),
      quality_failure_action = VALUES(quality_failure_action),
      auto_revision_scheduled = VALUES(auto_revision_scheduled)`,
    [
      result.id,
      result.documentId,
      result.documentVersionId ?? null,
      result.evaluatorJobId,
      result.status,
      result.score ?? null,
      result.summary ?? null,
      JSON.stringify(result.missingInformation),
      JSON.stringify(result.clarificationQuestions),
      JSON.stringify(result.riskItems),
      result.qualityFailureAction ?? null,
      result.autoRevisionScheduled,
      toMysqlDateTime(result.createdAt)
    ]
  );
}

async function upsertFeedbackItem(executor: MysqlQueryExecutor, feedback: WorkflowFeedbackItem): Promise<void> {
  await executor.execute(
    `INSERT INTO feedback_item (
      id, document_id, work_item_id, source, author, body, external_id, external_url,
      metadata_json, revision_job_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      author = VALUES(author),
      body = VALUES(body),
      external_url = VALUES(external_url),
      metadata_json = VALUES(metadata_json),
      revision_job_id = VALUES(revision_job_id)`,
    [
      feedback.id,
      feedback.documentId,
      feedback.workItemId,
      feedback.source,
      feedback.author ?? null,
      feedback.body,
      feedback.externalId ?? null,
      feedback.externalUrl ?? null,
      JSON.stringify(feedback.metadata ?? {}),
      feedback.revisionJobId ?? null,
      toMysqlDateTime(feedback.createdAt)
    ]
  );
}

async function insertWorkflowEvent(
  executor: MysqlQueryExecutor,
  event: WorkflowMutationEvent,
  idGenerator: (prefix: string) => string
): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_event (
      id, run_id, job_id, type, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      idGenerator("event"),
      event.runId,
      event.jobId ?? null,
      event.type,
      event.message,
      JSON.stringify(event.metadata),
      toMysqlDateTime(event.createdAt)
    ]
  );
}

async function insertDocumentWorkflowEvent(
  executor: MysqlQueryExecutor,
  event: WorkflowDocumentMutationEvent,
  idGenerator: (prefix: string) => string
): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_event (
      id, run_id, job_id, type, message, metadata_json, created_at
    )
    SELECT ?, workflow_run_id, ?, ?, ?, ?, ?
    FROM document
    WHERE id = ?`,
    [
      idGenerator("event"),
      event.jobId ?? null,
      event.type,
      event.message,
      JSON.stringify(event.metadata),
      toMysqlDateTime(event.createdAt),
      event.documentId
    ]
  );
}
