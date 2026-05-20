import type { Document } from "../document-core/domain";
import type { AgentJob } from "../prd-confirmation/domain";
import type {
  WorkflowEngineExternalIssueStatus,
  WorkflowEngineTransitionType,
  WorkflowEngineWorkItemState
} from "../prd-confirmation/workflow-engine";
import type { MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface RecordDocumentStateCommandInput {
  document: Document;
  now?: Date;
}

export interface RecordWorkflowJobCommandInput {
  runId: string;
  job: AgentJob;
  now?: Date;
}

export interface RecordEngineTransitionCommandInput {
  transitionType?: WorkflowEngineTransitionType;
  affectedWorkItemIds?: string[];
  affectedDocumentIds?: string[];
  workItemState?: WorkflowEngineWorkItemState;
  externalIssueStatus?: WorkflowEngineExternalIssueStatus;
  documents: Document[];
  jobs: Array<{
    runId: string;
    job: AgentJob;
  }>;
  now?: Date;
}

export interface WorkflowTransitionCommand {
  recordDocumentState(input: RecordDocumentStateCommandInput): Promise<void>;
  recordWorkflowJob(input: RecordWorkflowJobCommandInput): Promise<void>;
  recordEngineTransition?(input: RecordEngineTransitionCommandInput): Promise<void>;
}

export class MysqlWorkflowTransitionCommand implements WorkflowTransitionCommand {
  constructor(private readonly database: MysqlDatabase) {}

  async recordDocumentState(input: RecordDocumentStateCommandInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      await upsertDocumentState(connection, input);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordWorkflowJob(input: RecordWorkflowJobCommandInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      await upsertWorkflowJob(connection, input);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordEngineTransition(input: RecordEngineTransitionCommandInput): Promise<void> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();

      for (const document of input.documents) {
        await upsertDocumentState(connection, {
          document,
          now: input.now
        });
      }

      for (const job of input.jobs) {
        await upsertWorkflowJob(connection, {
          ...job,
          now: input.now
        });
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

async function upsertDocumentState(
  executor: MysqlQueryExecutor,
  input: RecordDocumentStateCommandInput
): Promise<void> {
  const now = toIso(input.now ?? new Date(input.document.updatedAt));

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
      input.document.id,
      input.document.workflowRunId,
      input.document.parentDocumentId ?? null,
      input.document.type,
      input.document.sourceKey,
      input.document.title,
      input.document.status,
      input.document.createdAt,
      now
    ]
  );
}

async function upsertWorkflowJob(
  executor: MysqlQueryExecutor,
  input: RecordWorkflowJobCommandInput
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

function capabilitiesForJobType(jobType: AgentJob["jobType"]): string[] {
  if (jobType === "implementation.open_pr" || jobType === "implementation.collect_pr_status") {
    return [jobType];
  }

  if (jobType === "prd.evaluate_quality" || jobType === "document.evaluate") {
    return ["document.evaluate"];
  }

  if (jobType === "prd.route_downstream") {
    return ["workflow.route"];
  }

  if (jobType === "document.fan_out") {
    return ["workflow.fanout"];
  }

  if (jobType === "document.revise") {
    return ["document.revise"];
  }

  return ["document.generate"];
}

function roleForJobType(jobType: AgentJob["jobType"]): string {
  if (
    jobType.startsWith("implementation.") ||
    jobType === "prd.evaluate_quality" ||
    jobType === "prd.route_downstream" ||
    jobType.startsWith("document.")
  ) {
    return "developer";
  }

  return "planner";
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
