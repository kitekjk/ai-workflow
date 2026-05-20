import type { AgentJob, FeedbackItem } from "../prd-confirmation/domain";
import type { MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface RecordFeedbackCommandInput {
  feedback: FeedbackItem;
}

export interface RecordRevisionJobCommandInput {
  runId: string;
  job: AgentJob;
  feedbackItems: FeedbackItem[];
  now?: Date;
}

export interface FeedbackRevisionCommand {
  recordFeedback(input: RecordFeedbackCommandInput): Promise<void>;
  recordRevisionJob(input: RecordRevisionJobCommandInput): Promise<void>;
}

export class MysqlFeedbackRevisionCommand implements FeedbackRevisionCommand {
  constructor(private readonly database: MysqlDatabase) {}

  async recordFeedback(input: RecordFeedbackCommandInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      await upsertFeedbackItem(connection, input.feedback);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordRevisionJob(input: RecordRevisionJobCommandInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      await upsertRevisionJob(connection, input);

      for (const feedback of input.feedbackItems) {
        await upsertFeedbackItem(connection, feedback);
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

async function upsertRevisionJob(
  executor: MysqlQueryExecutor,
  input: RecordRevisionJobCommandInput
): Promise<void> {
  const now = toIso(input.now);

  await executor.execute(
    `INSERT INTO workflow_job (
      id, run_id, job_type, status, input_json, priority, project_id, repository_id,
      assigned_user_id, assigned_team_id, required_role, required_capabilities_json,
      preferred_engine, required_engine, execution_policy, assigned_runner_id,
      claimed_by_runner_id, claimed_at, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)
    ON DUPLICATE KEY UPDATE
      job_type = VALUES(job_type),
      input_json = VALUES(input_json),
      priority = VALUES(priority),
      project_id = VALUES(project_id),
      repository_id = VALUES(repository_id),
      required_role = VALUES(required_role),
      required_capabilities_json = VALUES(required_capabilities_json),
      execution_policy = VALUES(execution_policy),
      updated_at = VALUES(updated_at)`,
    [
      input.job.id,
      input.runId,
      input.job.jobType,
      input.job.status,
      JSON.stringify(input.job.input),
      0,
      "prd-confirmation",
      "prd-docs",
      roleForJobType(input.job.jobType),
      JSON.stringify(capabilitiesForJobType(input.job.jobType)),
      "local_allowed",
      now,
      now
    ]
  );
}

async function upsertFeedbackItem(executor: MysqlQueryExecutor, feedback: FeedbackItem): Promise<void> {
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
      feedback.createdAt
    ]
  );
}

function capabilitiesForJobType(jobType: AgentJob["jobType"]): string[] {
  if (jobType === "document.revise") {
    return ["document.revise"];
  }

  return ["document.generate"];
}

function roleForJobType(jobType: AgentJob["jobType"]): string {
  if (jobType === "document.revise") {
    return "developer";
  }

  return "planner";
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
