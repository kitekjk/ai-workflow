import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../../document-core/domain";
import type { MysqlDatabase } from "../../workflow-core/mysql-repository";
import type { WorkflowJob, WorkflowJobResult, WorkflowRun, WorkflowTask } from "../../workflow-core/domain";
import type { FeedbackItem } from "./domain";
import type { GenericPrdSnapshot } from "./generic-adapter";

export interface PrdSnapshotMirror {
  persist(snapshot: GenericPrdSnapshot): Promise<void>;
}

export class MysqlPrdSnapshotMirror implements PrdSnapshotMirror {
  constructor(private readonly database: MysqlDatabase) {}

  async persist(snapshot: GenericPrdSnapshot): Promise<void> {
    for (const run of snapshot.workflowRuns) {
      await this.upsertWorkflowRun(run);
    }

    for (const task of snapshot.workflowTasks) {
      await this.upsertWorkflowTask(task);
    }

    for (const job of snapshot.workflowJobs) {
      await this.upsertWorkflowJob(job);
    }

    for (const result of snapshot.workflowJobResults) {
      await this.upsertWorkflowJobResult(result);
    }

    for (const document of snapshot.documents) {
      await this.upsertDocumentWithoutCurrentPointers(document);
    }

    for (const version of snapshot.documentVersions) {
      await this.upsertDocumentVersion(version);
    }

    for (const artifact of snapshot.artifacts) {
      await this.upsertArtifact(artifact);
    }

    for (const document of snapshot.documents) {
      await this.updateDocumentCurrentPointers(document);
    }

    for (const qualityResult of snapshot.qualityResults) {
      await this.upsertQualityResult(qualityResult);
    }

    for (const feedback of snapshot.feedbackItems) {
      await this.upsertFeedbackItem(feedback);
    }
  }

  private async upsertWorkflowRun(run: WorkflowRun): Promise<void> {
    await this.database.execute(
      `INSERT INTO workflow_run (
        id, workflow_definition_id, status, source_type, source_key, output_language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
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
        run.createdAt,
        run.updatedAt
      ]
    );
  }

  private async upsertWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.database.execute(
      `INSERT INTO workflow_task (
        id, run_id, parent_task_id, task_type, source_key, title, status,
        current_document_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        parent_task_id = VALUES(parent_task_id),
        task_type = VALUES(task_type),
        source_key = VALUES(source_key),
        title = VALUES(title),
        status = VALUES(status),
        current_document_id = VALUES(current_document_id),
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
        JSON.stringify(task.metadata ?? {}),
        task.createdAt,
        task.updatedAt
      ]
    );
  }

  private async upsertWorkflowJob(job: WorkflowJob): Promise<void> {
    await this.database.execute(
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
        job.claimedAt ?? null,
        job.leaseExpiresAt ?? null,
        job.createdAt,
        job.updatedAt
      ]
    );
  }

  private async upsertWorkflowJobResult(result: WorkflowJobResult): Promise<void> {
    await this.database.execute(
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

  private async upsertDocumentWithoutCurrentPointers(document: Document): Promise<void> {
    await this.database.execute(
      `INSERT INTO document (
        id, workflow_run_id, workflow_task_id, parent_document_id, type, source_key, title, status,
        current_version_id, current_markdown_artifact_id, current_wiki_artifact_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON DUPLICATE KEY UPDATE
        workflow_task_id = VALUES(workflow_task_id),
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
        document.createdAt,
        document.updatedAt
      ]
    );
  }

  private async upsertDocumentVersion(version: DocumentVersion): Promise<void> {
    await this.database.execute(
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

  private async upsertArtifact(artifact: Artifact): Promise<void> {
    await this.database.execute(
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

  private async updateDocumentCurrentPointers(document: Document): Promise<void> {
    await this.database.execute(
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

  private async upsertQualityResult(result: DocumentQualityResult): Promise<void> {
    await this.database.execute(
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

  private async upsertFeedbackItem(feedback: FeedbackItem): Promise<void> {
    await this.database.execute(
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
        feedback.createdAt
      ]
    );
  }
}
