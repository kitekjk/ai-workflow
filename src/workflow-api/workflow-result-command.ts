import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import type { MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface RecordWorkflowResultProjectionInput {
  jobId: string;
  jobs: WorkflowJob[];
  jobResults: WorkflowJobResult[];
  documents: Document[];
  documentVersions: DocumentVersion[];
  artifacts: Artifact[];
  qualityResults: DocumentQualityResult[];
}

export interface WorkflowResultCommand {
  recordResultProjection(input: RecordWorkflowResultProjectionInput): Promise<void>;
}

export class MysqlWorkflowResultCommand implements WorkflowResultCommand {
  constructor(private readonly database: MysqlDatabase) {}

  async recordResultProjection(input: RecordWorkflowResultProjectionInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();

      for (const job of input.jobs) {
        await upsertWorkflowJob(connection, job);
      }

      for (const result of input.jobResults) {
        await upsertWorkflowJobResult(connection, result);
      }

      for (const document of input.documents) {
        await upsertDocumentWithoutCurrentPointers(connection, document);
      }

      for (const version of input.documentVersions) {
        await upsertDocumentVersion(connection, version);
      }

      for (const artifact of input.artifacts) {
        await upsertArtifact(connection, artifact);
      }

      for (const document of input.documents) {
        await updateDocumentCurrentPointers(connection, document);
      }

      for (const qualityResult of input.qualityResults) {
        await upsertQualityResult(connection, qualityResult);
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

async function upsertWorkflowJob(executor: MysqlQueryExecutor, job: WorkflowJob): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_job (
      id, run_id, job_type, status, input_json, priority, project_id, repository_id,
      assigned_user_id, assigned_team_id, required_role, required_capabilities_json,
      preferred_engine, required_engine, execution_policy, assigned_runner_id,
      claimed_by_runner_id, claimed_at, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
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
      job.claimedAt ?? null,
      job.leaseExpiresAt ?? null,
      job.createdAt,
      job.updatedAt
    ]
  );
}

async function upsertWorkflowJobResult(executor: MysqlQueryExecutor, result: WorkflowJobResult): Promise<void> {
  await executor.execute(
    `INSERT INTO workflow_job_result (
      id, job_id, runner_id, attempt_no, status, output_json, error_code, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      output_json = VALUES(output_json),
      error_code = VALUES(error_code),
      error_message = VALUES(error_message)`,
    [
      result.id,
      result.jobId,
      result.runnerId ?? null,
      result.attemptNo,
      result.status,
      JSON.stringify(result.output),
      result.errorCode ?? null,
      result.errorMessage ?? null,
      result.createdAt
    ]
  );
}

async function upsertDocumentWithoutCurrentPointers(
  executor: MysqlQueryExecutor,
  document: Document
): Promise<void> {
  await executor.execute(
    `INSERT INTO document (
      id, workflow_run_id, parent_document_id, type, source_key, title, status,
      current_version_id, current_markdown_artifact_id, current_wiki_artifact_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      parent_document_id = VALUES(parent_document_id),
      type = VALUES(type),
      source_key = VALUES(source_key),
      title = VALUES(title),
      status = VALUES(status),
      updated_at = VALUES(updated_at)`,
    [
      document.id,
      document.workflowRunId,
      document.parentDocumentId ?? null,
      document.type,
      document.sourceKey,
      document.title,
      document.status,
      document.createdAt,
      document.updatedAt
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
      version.createdAt
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
      artifact.createdAt
    ]
  );
}

async function updateDocumentCurrentPointers(executor: MysqlQueryExecutor, document: Document): Promise<void> {
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
      document.updatedAt,
      document.id
    ]
  );
}

async function upsertQualityResult(
  executor: MysqlQueryExecutor,
  result: DocumentQualityResult
): Promise<void> {
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
      result.createdAt
    ]
  );
}
