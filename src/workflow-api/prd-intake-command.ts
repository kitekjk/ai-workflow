import type { MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface RecordPrdIntakeInput {
  runId: string;
  workItemId: string;
  jobId: string;
  prdJiraKey: string;
  title?: string;
  now?: Date;
}

export interface RecordPrdIntakeResult {
  runId: string;
  documentId: string;
  jobId: string;
}

export interface PrdIntakeCommand {
  recordIntake(input: RecordPrdIntakeInput): Promise<RecordPrdIntakeResult>;
}

export class MysqlPrdIntakeCommand implements PrdIntakeCommand {
  constructor(private readonly database: MysqlDatabase) {}

  async recordIntake(input: RecordPrdIntakeInput): Promise<RecordPrdIntakeResult> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      await upsertWorkflowRun(connection, input);
      await upsertPrdDocument(connection, input);
      await upsertDraftJob(connection, input);
      await connection.commit();

      return {
        runId: input.runId,
        documentId: documentIdForWorkItem(input.workItemId),
        jobId: input.jobId
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function upsertWorkflowRun(executor: MysqlQueryExecutor, input: RecordPrdIntakeInput): Promise<void> {
  const now = toIso(input.now);

  await executor.execute(
    `INSERT INTO workflow_run (
      id, workflow_definition_id, status, source_type, source_key, output_language, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_key = VALUES(source_key),
      output_language = VALUES(output_language),
      updated_at = VALUES(updated_at)`,
    [input.runId, "prd_confirmation", "active", "jira", input.prdJiraKey, "ko", now, now]
  );
}

async function upsertPrdDocument(executor: MysqlQueryExecutor, input: RecordPrdIntakeInput): Promise<void> {
  const now = toIso(input.now);

  await executor.execute(
    `INSERT INTO document (
      id, workflow_run_id, parent_document_id, type, source_key, title, status,
      current_version_id, current_markdown_artifact_id, current_wiki_artifact_id, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_key = VALUES(source_key),
      title = VALUES(title),
      updated_at = VALUES(updated_at)`,
    [
      documentIdForWorkItem(input.workItemId),
      input.runId,
      "prd",
      input.prdJiraKey,
      input.title ?? input.prdJiraKey,
      "draft",
      now,
      now
    ]
  );
}

async function upsertDraftJob(executor: MysqlQueryExecutor, input: RecordPrdIntakeInput): Promise<void> {
  const now = toIso(input.now);

  await executor.execute(
    `INSERT INTO workflow_job (
      id, run_id, job_type, status, input_json, priority, project_id, repository_id,
      assigned_user_id, assigned_team_id, required_role, required_capabilities_json,
      preferred_engine, required_engine, execution_policy, assigned_runner_id,
      claimed_by_runner_id, claimed_at, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      input_json = VALUES(input_json),
      project_id = VALUES(project_id),
      repository_id = VALUES(repository_id),
      required_role = VALUES(required_role),
      required_capabilities_json = VALUES(required_capabilities_json),
      execution_policy = VALUES(execution_policy),
      updated_at = VALUES(updated_at)`,
    [
      input.jobId,
      input.runId,
      "prd.generate_draft",
      "pending",
      JSON.stringify({}),
      0,
      "prd-confirmation",
      "prd-docs",
      "planner",
      JSON.stringify(["document.generate"]),
      "local_allowed",
      now,
      now
    ]
  );
}

function documentIdForWorkItem(workItemId: string): string {
  return `doc_${workItemId}`;
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
