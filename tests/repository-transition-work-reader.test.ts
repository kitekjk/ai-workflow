import { describe, expect, it } from "vitest";
import { MysqlRepositoryTransitionWorkReader } from "../src/workflow-api/repository-transition-work-reader";
import type { MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlRepositoryTransitionWorkReader", () => {
  it("reads the oldest terminal job result that has not been transitioned", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database, {
      workerId: "transition-worker-a",
      leaseMs: 30_000
    });
    database.queueRows([pendingResultRow()]);
    database.queueResult({ affectedRows: 1 });

    const pending = await reader.nextPendingJobResult({
      now: new Date("2026-05-21T00:02:00.000Z")
    });

    expect(pending).toMatchObject({
      job: {
        id: "job_1",
        runId: "run_1",
        jobType: "prd.evaluate_quality",
        status: "succeeded",
        input: {
          sourceDocumentId: "doc_1"
        }
      },
      jobResult: {
        id: "result_1",
        jobId: "job_1",
        runnerId: "runner_1",
        attemptNo: 1,
        status: "succeeded",
        output: {
          status: "passed"
        }
      }
    });
    expect(database.statements[0]).toMatchObject({
      sql: expect.stringContaining("FROM workflow_job_result result"),
      params: expect.arrayContaining([
        "workflow.engine_transition",
        "2026-05-21T00:02:00.000Z",
        "prd.evaluate_quality"
      ])
    });
    expect(database.statements[0]?.sql).toContain("JSON_UNQUOTE(JSON_EXTRACT(event.metadata_json, '$.processedResult.resultId')) = result.id");
    expect(database.statements[0]?.sql).toContain("LEFT JOIN workflow_transition_claim claim");
    expect(database.statements[0]?.sql).toContain("claim.workflow_job_result_id IS NULL");
    expect(database.statements[0]?.sql).toContain("job.status IN ('succeeded', 'failed', 'canceled')");
    expect(database.statements[0]?.sql).toContain("event.id IS NULL");
    expect(database.statements[0]?.sql).toContain("ORDER BY result.created_at ASC, result.id ASC LIMIT 1");
    expect(database.statements[1]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO workflow_transition_claim"),
      params: [
        "result_1",
        "job_1",
        "run_1",
        "claimed",
        "transition-worker-a",
        "2026-05-21T00:02:00.000Z",
        "2026-05-21T00:02:30.000Z",
        "2026-05-21T00:02:00.000Z"
      ]
    });
  });

  it("returns undefined when there are no pending transition results", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database);
    database.queueRows([]);

    await expect(reader.nextPendingJobResult()).resolves.toBeUndefined();
  });

  it("returns undefined when another transition worker claims the candidate first", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database, {
      workerId: "transition-worker-a"
    });
    database.queueRows([pendingResultRow()]);
    database.queueResult({ affectedRows: 0 });

    await expect(
      reader.nextPendingJobResult({
        now: new Date("2026-05-21T00:02:00.000Z")
      })
    ).resolves.toBeUndefined();
  });

  it("marks a claimed transition result as processed", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database);
    database.queueResult({ affectedRows: 1 });

    await reader.markJobResultProcessed({
      jobResultId: "result_1",
      now: new Date("2026-05-21T00:03:00.000Z")
    });

    expect(database.statements[0]).toMatchObject({
      sql: expect.stringContaining("UPDATE workflow_transition_claim"),
      params: [
        "processed",
        "2026-05-21T00:03:00.000Z",
        "2026-05-21T00:03:00.000Z",
        "result_1"
      ]
    });
    expect(database.statements[0]?.sql).toContain("WHERE workflow_job_result_id = ?");
  });
});

class FakeMysqlDatabase implements MysqlDatabase {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  private readonly responses: unknown[] = [];

  queueRows(rows: unknown[]): void {
    this.responses.push(rows);
  }

  queueResult(result: unknown): void {
    this.responses.push(result);
  }

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });
    return [(this.responses.shift() ?? []) as T, undefined];
  }

  async getConnection(): Promise<never> {
    throw new Error("reader does not need a transaction connection");
  }
}

function pendingResultRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job_1",
    run_id: "run_1",
    job_type: "prd.evaluate_quality",
    status: "succeeded",
    input_json: JSON.stringify({ sourceDocumentId: "doc_1" }),
    priority: 0,
    project_id: "prd-confirmation",
    repository_id: "prd-docs",
    assigned_user_id: "planner@example.com",
    assigned_team_id: null,
    required_role: "planner",
    required_capabilities_json: JSON.stringify(["document.evaluate"]),
    preferred_engine: null,
    required_engine: null,
    execution_policy: "local_allowed",
    assigned_runner_id: null,
    claimed_by_runner_id: "runner_1",
    claimed_at: "2026-05-21T00:00:00.000Z",
    lease_expires_at: "2026-05-21T00:01:00.000Z",
    created_at: "2026-05-21T00:00:00.000Z",
    updated_at: "2026-05-21T00:01:00.000Z",
    result_id: "result_1",
    result_job_id: "job_1",
    result_runner_id: "runner_1",
    result_attempt_no: 1,
    result_status: "succeeded",
    result_output_json: JSON.stringify({ status: "passed" }),
    result_error_code: null,
    result_error_message: null,
    result_created_at: "2026-05-21T00:01:00.000Z",
    ...overrides
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
