import { randomUUID } from "node:crypto";
import type {
  ClaimJobInput,
  ClaimJobResult,
  Runner,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun
} from "./domain";
import { canRunnerClaimJob } from "./domain";
import type {
  AppendWorkflowEventInput,
  AcknowledgeWorkflowJobCancellationInput,
  CompleteWorkflowJobInput,
  CreateWorkflowJobInput,
  CreateWorkflowRunInput,
  FailWorkflowJobInput,
  ListWorkflowEventsInput,
  RecordWorkflowJobResultInput,
  RequestWorkflowJobCancellationInput,
  WorkflowRepository
} from "./repository";

export interface MysqlQueryExecutor {
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
}

export interface MysqlConnection extends MysqlQueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MysqlDatabase extends MysqlQueryExecutor {
  getConnection(): Promise<MysqlConnection>;
  end?(): Promise<void>;
}

export interface MysqlWorkflowRepositoryOptions {
  idGenerator?: (prefix: string) => string;
}

type MysqlRow = Record<string, unknown>;

export class MysqlWorkflowRepository implements WorkflowRepository {
  private readonly idGenerator: (prefix: string) => string;

  constructor(
    private readonly database: MysqlDatabase,
    options: MysqlWorkflowRepositoryOptions = {}
  ) {
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async createWorkflowRun(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
    const now = toIso(input.now);
    const run: WorkflowRun = {
      id: this.idGenerator("run"),
      workflowDefinitionId: input.workflowDefinitionId,
      status: "active",
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      outputLanguage: input.outputLanguage ?? "ko",
      createdAt: now,
      updatedAt: now
    };

    await this.database.execute(
      `INSERT INTO workflow_run (
        id, workflow_definition_id, status, source_type, source_key, output_language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

    return run;
  }

  async createWorkflowJob(input: CreateWorkflowJobInput): Promise<WorkflowJob> {
    const now = toIso(input.now);
    const job: WorkflowJob = {
      id: this.idGenerator("job"),
      runId: input.runId,
      jobType: input.jobType,
      status: "pending",
      input: input.input ?? {},
      priority: input.priority ?? 0,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      assignedUserId: input.assignedUserId,
      assignedTeamId: input.assignedTeamId,
      requiredRole: input.requiredRole,
      requiredCapabilities: input.requiredCapabilities ?? [],
      preferredEngine: input.preferredEngine,
      requiredEngine: input.requiredEngine,
      executionPolicy: input.executionPolicy ?? "local_allowed",
      assignedRunnerId: input.assignedRunnerId,
      createdAt: now,
      updatedAt: now
    };

    await this.database.execute(
      `INSERT INTO workflow_job (
        id, run_id, job_type, status, input_json, priority, project_id, repository_id,
        assigned_user_id, assigned_team_id, required_role, required_capabilities_json,
        preferred_engine, required_engine, execution_policy, assigned_runner_id,
        claimed_by_runner_id, claimed_at, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobToParams(job)
    );

    return job;
  }

  async getWorkflowJob(jobId: string): Promise<WorkflowJob | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(`SELECT * FROM workflow_job WHERE id = ?`, [jobId]);
    const row = rows[0];

    return row ? rowToWorkflowJob(row) : undefined;
  }

  async upsertRunner(runner: Runner): Promise<Runner> {
    const now = runner.lastHeartbeatAt ?? new Date().toISOString();

    await this.database.execute(
      `INSERT INTO runner (
        id, owner_user_id, mode, status, team_ids_json, allowed_project_ids_json,
        allowed_repository_ids_json, capabilities_json, engines_json, default_engine,
        concurrency, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        owner_user_id = VALUES(owner_user_id),
        mode = VALUES(mode),
        status = VALUES(status),
        team_ids_json = VALUES(team_ids_json),
        allowed_project_ids_json = VALUES(allowed_project_ids_json),
        allowed_repository_ids_json = VALUES(allowed_repository_ids_json),
        capabilities_json = VALUES(capabilities_json),
        engines_json = VALUES(engines_json),
        default_engine = VALUES(default_engine),
        concurrency = VALUES(concurrency),
        last_heartbeat_at = VALUES(last_heartbeat_at),
        updated_at = VALUES(updated_at)`,
      [
        runner.id,
        runner.ownerUserId ?? null,
        runner.mode,
        runner.status,
        JSON.stringify(runner.teamIds),
        JSON.stringify(runner.allowedProjectIds),
        JSON.stringify(runner.allowedRepositoryIds),
        JSON.stringify(runner.capabilities),
        JSON.stringify(runner.engines),
        runner.defaultEngine ?? null,
        runner.concurrency,
        runner.lastHeartbeatAt ?? null,
        now,
        now
      ]
    );

    return runner;
  }

  async heartbeatRunner(runnerId: string, now: Date): Promise<Runner> {
    await this.database.execute(
      `UPDATE runner
       SET status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'online' END,
           last_heartbeat_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [now.toISOString(), now.toISOString(), runnerId]
    );

    return this.requireRunner(this.database, runnerId);
  }

  async claimNextJob(input: ClaimJobInput): Promise<ClaimJobResult | undefined> {
    return this.withTransaction(async (connection) => {
      const runner = await this.requireRunner(connection, input.runnerId, true);
      const jobs = await this.selectClaimCandidates(connection, input.now);
      const job = jobs.find((candidate) => canRunnerClaimJob(runner, candidate, input.now));

      if (!job) {
        return undefined;
      }

      job.status = "claimed";
      job.claimedByRunnerId = runner.id;
      job.claimedAt = input.now.toISOString();
      job.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      job.updatedAt = input.now.toISOString();

      await connection.execute(
        `UPDATE workflow_job
         SET status = ?, claimed_by_runner_id = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ?`,
        [job.status, job.claimedByRunnerId, job.claimedAt, job.leaseExpiresAt, job.updatedAt, job.id]
      );

      return { job, runner };
    });
  }

  async startClaimedJob(jobId: string, runnerId: string, now: Date): Promise<WorkflowJob> {
    await this.database.execute(
      `UPDATE workflow_job
       SET status = 'running', updated_at = ?
       WHERE id = ? AND claimed_by_runner_id = ? AND status = 'claimed'`,
      [now.toISOString(), jobId, runnerId]
    );

    return this.requireJob(jobId);
  }

  async completeJob(input: CompleteWorkflowJobInput): Promise<WorkflowJobResult> {
    return this.withTransaction(async (connection) => {
      const job = await this.requireClaimedJob(connection, input.jobId, input.runnerId);

      if (job.status === "cancel_requested") {
        throw new Error(`Job cancellation requested: ${input.jobId}`);
      }

      const result = await this.recordJobResultInTransaction(connection, {
        jobId: input.jobId,
        runnerId: input.runnerId,
        status: "succeeded",
        output: input.output,
        now: input.now
      });

      await connection.execute(
        `UPDATE workflow_job SET status = 'succeeded', updated_at = ? WHERE id = ?`,
        [input.now.toISOString(), input.jobId]
      );

      return result;
    });
  }

  async failJob(input: FailWorkflowJobInput): Promise<WorkflowJobResult> {
    return this.withTransaction(async (connection) => {
      const job = await this.requireClaimedJob(connection, input.jobId, input.runnerId);

      if (job.status === "cancel_requested") {
        throw new Error(`Job cancellation requested: ${input.jobId}`);
      }

      const result = await this.recordJobResultInTransaction(connection, {
        jobId: input.jobId,
        runnerId: input.runnerId,
        status: "failed",
        output: input.output,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        now: input.now
      });
      const status = input.retryable ? "retrying" : "failed";

      await connection.execute(
        `UPDATE workflow_job
         SET status = ?, claimed_by_runner_id = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
        [status, input.now.toISOString(), input.jobId]
      );

      return result;
    });
  }

  async requestJobCancellation(input: RequestWorkflowJobCancellationInput): Promise<WorkflowJob> {
    return this.withTransaction(async (connection) => {
      const job = await this.requireJobInTransaction(connection, input.jobId, true);

      if (isTerminalJobStatus(job.status)) {
        return job;
      }

      const status = job.status === "pending" || job.status === "retrying" ? "canceled" : "cancel_requested";
      const clearClaim = status === "canceled";

      await connection.execute(
        `UPDATE workflow_job
         SET status = ?,
             claimed_by_runner_id = ${clearClaim ? "NULL" : "claimed_by_runner_id"},
             claimed_at = ${clearClaim ? "NULL" : "claimed_at"},
             lease_expires_at = ${clearClaim ? "NULL" : "lease_expires_at"},
             updated_at = ?
         WHERE id = ?`,
        [status, input.now.toISOString(), input.jobId]
      );

      return {
        ...job,
        status,
        claimedByRunnerId: clearClaim ? undefined : job.claimedByRunnerId,
        claimedAt: clearClaim ? undefined : job.claimedAt,
        leaseExpiresAt: clearClaim ? undefined : job.leaseExpiresAt,
        updatedAt: input.now.toISOString()
      };
    });
  }

  async acknowledgeJobCancellation(
    input: AcknowledgeWorkflowJobCancellationInput
  ): Promise<WorkflowJobResult> {
    return this.withTransaction(async (connection) => {
      const job = await this.requireClaimedJob(connection, input.jobId, input.runnerId);

      if (job.status !== "cancel_requested") {
        throw new Error(`Job cancellation not requested: ${input.jobId}`);
      }

      const result = await this.recordJobResultInTransaction(connection, {
        jobId: input.jobId,
        runnerId: input.runnerId,
        status: "canceled",
        output: input.output,
        now: input.now
      });

      await connection.execute(
        `UPDATE workflow_job
         SET status = 'canceled', claimed_by_runner_id = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
        [input.now.toISOString(), input.jobId]
      );

      return result;
    });
  }

  async recoverExpiredLeases(now: Date): Promise<WorkflowJob[]> {
    return this.withTransaction(async (connection) => {
      const [rows] = await connection.execute<MysqlRow[]>(
        `SELECT * FROM workflow_job
         WHERE status IN ('claimed', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
         FOR UPDATE`,
        [now.toISOString()]
      );
      const jobs = rows.map(rowToWorkflowJob);

      if (jobs.length === 0) {
        return [];
      }

      await connection.execute(
        `UPDATE workflow_job
         SET status = 'retrying', claimed_by_runner_id = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id IN (${jobs.map(() => "?").join(", ")})`,
        [now.toISOString(), ...jobs.map((job) => job.id)]
      );

      return jobs.map((job) => ({
        ...job,
        status: "retrying",
        claimedByRunnerId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now.toISOString()
      }));
    });
  }

  async recordJobResult(input: RecordWorkflowJobResultInput): Promise<WorkflowJobResult> {
    return this.withTransaction((connection) => this.recordJobResultInTransaction(connection, input));
  }

  async appendEvent(input: AppendWorkflowEventInput): Promise<WorkflowEvent> {
    const event: WorkflowEvent = {
      id: this.idGenerator("event"),
      runId: input.runId,
      jobId: input.jobId,
      type: input.type,
      message: input.message,
      metadata: input.metadata ?? {},
      createdAt: toIso(input.now)
    };

    await this.database.execute(
      `INSERT INTO workflow_event (
        id, run_id, job_id, type, message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.runId,
        event.jobId ?? null,
        event.type,
        event.message,
        JSON.stringify(event.metadata),
        event.createdAt
      ]
    );

    return event;
  }

  async listWorkflowEvents(input: ListWorkflowEventsInput): Promise<WorkflowEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.runId) {
      conditions.push("run_id = ?");
      params.push(input.runId);
    }

    if (input.jobId) {
      conditions.push("job_id = ?");
      params.push(input.jobId);
    }

    if (input.type) {
      conditions.push("type = ?");
      params.push(input.type);
    }

    if (input.after) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(input.after.createdAt, input.after.createdAt, input.after.id);
    }

    params.push(normalizeLimit(input.limit));
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT * FROM workflow_event
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      params
    );

    return rows.map(rowToWorkflowEvent);
  }

  private async selectClaimCandidates(connection: MysqlQueryExecutor, now: Date): Promise<WorkflowJob[]> {
    const [rows] = await connection.execute<MysqlRow[]>(
      `SELECT * FROM workflow_job
       WHERE status IN ('pending', 'retrying')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY priority DESC, created_at ASC
       FOR UPDATE`,
      [now.toISOString()]
    );

    return rows.map(rowToWorkflowJob);
  }

  private async requireRunner(
    executor: MysqlQueryExecutor,
    runnerId: string,
    forUpdate = false
  ): Promise<Runner> {
    const [rows] = await executor.execute<MysqlRow[]>(
      `SELECT * FROM runner WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [runnerId]
    );
    const row = rows[0];

    if (!row) {
      throw new Error(`Runner not found: ${runnerId}`);
    }

    return rowToRunner(row);
  }

  private async requireJob(jobId: string): Promise<WorkflowJob> {
    const [rows] = await this.database.execute<MysqlRow[]>(`SELECT * FROM workflow_job WHERE id = ?`, [jobId]);
    const row = rows[0];

    if (!row) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return rowToWorkflowJob(row);
  }

  private async requireJobInTransaction(
    connection: MysqlQueryExecutor,
    jobId: string,
    forUpdate = false
  ): Promise<WorkflowJob> {
    const [rows] = await connection.execute<MysqlRow[]>(
      `SELECT * FROM workflow_job WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [jobId]
    );
    const row = rows[0];

    if (!row) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return rowToWorkflowJob(row);
  }

  private async requireClaimedJob(
    connection: MysqlQueryExecutor,
    jobId: string,
    runnerId: string
  ): Promise<WorkflowJob> {
    const [rows] = await connection.execute<MysqlRow[]>(
      `SELECT * FROM workflow_job WHERE id = ? AND claimed_by_runner_id = ? FOR UPDATE`,
      [jobId, runnerId]
    );
    const row = rows[0];

    if (!row) {
      throw new Error(`Job is not claimed by runner ${runnerId}: ${jobId}`);
    }

    return rowToWorkflowJob(row);
  }

  private async recordJobResultInTransaction(
    connection: MysqlQueryExecutor,
    input: RecordWorkflowJobResultInput
  ): Promise<WorkflowJobResult> {
    const [attemptRows] = await connection.execute<Array<{ next_attempt_no: number }>>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt_no
       FROM workflow_job_result
       WHERE job_id = ?`,
      [input.jobId]
    );
    const result: WorkflowJobResult = {
      id: this.idGenerator("result"),
      jobId: input.jobId,
      runnerId: input.runnerId,
      attemptNo: Number(attemptRows[0]?.next_attempt_no ?? 1),
      status: input.status,
      output: input.output,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      createdAt: toIso(input.now)
    };

    await connection.execute(
      `INSERT INTO workflow_job_result (
        id, job_id, runner_id, attempt_no, status, output_json, error_code, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    return result;
  }

  private async withTransaction<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function jobToParams(job: WorkflowJob): unknown[] {
  return [
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
  ];
}

export function rowToWorkflowJob(row: MysqlRow): WorkflowJob {
  return {
    id: stringValue(row.id),
    runId: stringValue(row.run_id),
    jobType: stringValue(row.job_type),
    status: stringValue(row.status) as WorkflowJob["status"],
    input: parseJsonRecord(row.input_json),
    priority: numberValue(row.priority),
    projectId: optionalString(row.project_id),
    repositoryId: optionalString(row.repository_id),
    assignedUserId: optionalString(row.assigned_user_id),
    assignedTeamId: optionalString(row.assigned_team_id),
    requiredRole: optionalString(row.required_role),
    requiredCapabilities: parseJsonArray(row.required_capabilities_json),
    preferredEngine: optionalString(row.preferred_engine),
    requiredEngine: optionalString(row.required_engine),
    executionPolicy: stringValue(row.execution_policy) as WorkflowJob["executionPolicy"],
    assignedRunnerId: optionalString(row.assigned_runner_id),
    claimedByRunnerId: optionalString(row.claimed_by_runner_id),
    claimedAt: optionalIso(row.claimed_at),
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at)
  };
}

export function rowToRunner(row: MysqlRow): Runner {
  return {
    id: stringValue(row.id),
    ownerUserId: optionalString(row.owner_user_id),
    mode: stringValue(row.mode) as Runner["mode"],
    status: stringValue(row.status) as Runner["status"],
    teamIds: parseJsonArray(row.team_ids_json),
    allowedProjectIds: parseJsonArray(row.allowed_project_ids_json),
    allowedRepositoryIds: parseJsonArray(row.allowed_repository_ids_json),
    capabilities: parseJsonArray(row.capabilities_json),
    engines: parseJsonArray(row.engines_json),
    defaultEngine: optionalString(row.default_engine),
    concurrency: numberValue(row.concurrency),
    lastHeartbeatAt: optionalIso(row.last_heartbeat_at)
  };
}

export function rowToWorkflowEvent(row: MysqlRow): WorkflowEvent {
  return {
    id: stringValue(row.id),
    runId: stringValue(row.run_id),
    jobId: optionalString(row.job_id),
    type: stringValue(row.type),
    message: stringValue(row.message),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: isoValue(row.created_at)
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJsonArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
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

function optionalIso(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : isoValue(value);
}

function isoValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return stringValue(value);
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return 50;
  }

  return Math.min(value, 500);
}

function isTerminalJobStatus(status: WorkflowJob["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "skipped";
}
