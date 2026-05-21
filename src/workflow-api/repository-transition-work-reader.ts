import type { WorkflowJobResult } from "../workflow-core/domain";
import { rowToWorkflowJob, type MysqlDatabase } from "../workflow-core/mysql-repository";
import type { RepositoryTransitionPendingResultReader } from "./repository-transition-processor";
import { repositoryWorkflowTransitionJobTypes } from "./repository-transition-planner";
import type { RepositoryTransitionClaimStore } from "./repository-transition-worker";

type MysqlRow = Record<string, unknown>;

export interface MysqlRepositoryTransitionWorkReaderOptions {
  workerId?: string;
  leaseMs?: number;
}

interface MysqlAffectedRows {
  affectedRows?: number;
}

export class MysqlRepositoryTransitionWorkReader
  implements RepositoryTransitionPendingResultReader, RepositoryTransitionClaimStore {
  private readonly workerId: string;
  private readonly leaseMs: number;

  constructor(
    private readonly database: MysqlDatabase,
    options: MysqlRepositoryTransitionWorkReaderOptions = {}
  ) {
    this.workerId = options.workerId ?? "repository-transition-worker";
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async nextPendingJobResult(input: { now?: Date } = {}) {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT
         job.*,
         result.id AS result_id,
         result.job_id AS result_job_id,
         result.runner_id AS result_runner_id,
         result.attempt_no AS result_attempt_no,
         result.status AS result_status,
         result.output_json AS result_output_json,
         result.error_code AS result_error_code,
         result.error_message AS result_error_message,
         result.created_at AS result_created_at
       FROM workflow_job_result result
       INNER JOIN workflow_job job ON job.id = result.job_id
       LEFT JOIN workflow_event event
         ON event.type = ?
        AND event.job_id = result.job_id
        AND JSON_UNQUOTE(JSON_EXTRACT(event.metadata_json, '$.processedResult.resultId')) = result.id
       LEFT JOIN workflow_transition_claim claim
         ON claim.workflow_job_result_id = result.id
        AND (
          claim.status = 'processed'
          OR (claim.status = 'claimed' AND claim.lease_expires_at > ?)
        )
       WHERE job.status IN ('succeeded', 'failed', 'canceled')
         AND job.job_type IN (${repositoryWorkflowTransitionJobTypes.map(() => "?").join(", ")})
         AND event.id IS NULL
         AND claim.workflow_job_result_id IS NULL
       ORDER BY result.created_at ASC, result.id ASC
       LIMIT 1`,
      ["workflow.engine_transition", nowIso, ...repositoryWorkflowTransitionJobTypes]
    );
    const row = rows[0];

    if (!row) {
      return undefined;
    }

    const claimed = await this.claimResult(row, now);

    if (!claimed) {
      return undefined;
    }

    return {
      job: rowToWorkflowJob(row),
      jobResult: rowToWorkflowJobResult(row)
    };
  }

  private async claimResult(row: MysqlRow, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const [result] = await this.database.execute<MysqlAffectedRows>(
      `INSERT INTO workflow_transition_claim (
         workflow_job_result_id, job_id, run_id, status, claimed_by_worker_id,
         claimed_at, lease_expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         claimed_by_worker_id = IF(status <> 'processed' AND lease_expires_at <= VALUES(claimed_at), VALUES(claimed_by_worker_id), claimed_by_worker_id),
         status = IF(status <> 'processed' AND lease_expires_at <= VALUES(claimed_at), VALUES(status), status),
         claimed_at = IF(status <> 'processed' AND lease_expires_at <= VALUES(claimed_at), VALUES(claimed_at), claimed_at),
         lease_expires_at = IF(status <> 'processed' AND lease_expires_at <= VALUES(claimed_at), VALUES(lease_expires_at), lease_expires_at),
         updated_at = IF(status <> 'processed' AND lease_expires_at <= VALUES(claimed_at), VALUES(updated_at), updated_at)`,
      [
        stringValue(row.result_id),
        stringValue(row.result_job_id),
        stringValue(row.run_id),
        "claimed",
        this.workerId,
        nowIso,
        leaseExpiresAt,
        nowIso
      ]
    );

    return Number(result.affectedRows ?? 0) > 0;
  }

  async markJobResultProcessed(input: { jobResultId: string; now: Date }): Promise<void> {
    const nowIso = input.now.toISOString();

    await this.database.execute(
      `UPDATE workflow_transition_claim
       SET status = ?,
           processed_at = ?,
           updated_at = ?
       WHERE workflow_job_result_id = ?`,
      ["processed", nowIso, nowIso, input.jobResultId]
    );
  }
}

function rowToWorkflowJobResult(row: MysqlRow): WorkflowJobResult {
  return {
    id: stringValue(row.result_id),
    jobId: stringValue(row.result_job_id),
    runnerId: optionalString(row.result_runner_id),
    attemptNo: numberValue(row.result_attempt_no),
    status: stringValue(row.result_status) as WorkflowJobResult["status"],
    output: parseJsonRecord(row.result_output_json),
    errorCode: optionalString(row.result_error_code),
    errorMessage: optionalString(row.result_error_message),
    createdAt: isoValue(row.result_created_at)
  };
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
