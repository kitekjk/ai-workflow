import { describe, expect, it } from "vitest";
import { MysqlRepositoryTransitionWorkReader } from "../backend/src/workflow-api/repository-transition-work-reader";
import type { MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";

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
        "2026-05-21 00:02:00.000",
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
        "2026-05-21 00:02:00.000",
        "2026-05-21 00:02:30.000",
        "2026-05-21 00:02:00.000"
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

  it("retries the next visible result after losing a claim race", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database, {
      workerId: "transition-worker-a"
    });
    database.queueRows([pendingResultRow({ id: "job_1", result_id: "result_1", result_job_id: "job_1" })]);
    database.queueResult({ affectedRows: 0 });
    database.queueRows([pendingResultRow({ id: "job_2", result_id: "result_2", result_job_id: "job_2" })]);
    database.queueResult({ affectedRows: 1 });

    const pending = await reader.nextPendingJobResult({
      now: new Date("2026-05-21T00:02:00.000Z")
    });

    expect(pending?.job.id).toBe("job_2");
    expect(pending?.jobResult.id).toBe("result_2");
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("FROM workflow_job_result result"),
      expect.stringContaining("INSERT INTO workflow_transition_claim"),
      expect.stringContaining("FROM workflow_job_result result"),
      expect.stringContaining("INSERT INTO workflow_transition_claim")
    ]);
  });

  it("lets parallel transition workers claim distinct results under contention", async () => {
    const workerCount = 8;
    const now = new Date("2026-05-21T00:02:00.000Z");
    const processedAt = new Date("2026-05-21T00:03:00.000Z");
    const database = new ConcurrentTransitionMysqlDatabase(
      Array.from({ length: workerCount }, (_, index) =>
        pendingResultRow({
          id: `job_${index + 1}`,
          result_id: `result_${index + 1}`,
          result_job_id: `job_${index + 1}`,
          result_created_at: `2026-05-21T00:01:0${index}.000Z`
        })
      )
    );
    const readers = Array.from({ length: workerCount }, (_, index) =>
      new MysqlRepositoryTransitionWorkReader(database, {
        workerId: `transition-worker-${index + 1}`,
        leaseMs: 30_000,
        claimAttemptLimit: workerCount
      })
    );

    const pendingResults = await Promise.all(
      readers.map((reader) =>
        reader.nextPendingJobResult({
          now
        })
      )
    );
    const claimedResults = pendingResults.filter(
      (pending): pending is NonNullable<(typeof pendingResults)[number]> => pending !== undefined
    );
    const claimedResultIds = claimedResults.map((pending) => pending.jobResult.id);

    expect(claimedResults).toHaveLength(workerCount);
    expect(new Set(claimedResultIds).size).toBe(workerCount);
    expect(claimedResultIds.sort()).toEqual([
      "result_1",
      "result_2",
      "result_3",
      "result_4",
      "result_5",
      "result_6",
      "result_7",
      "result_8"
    ]);

    await Promise.all(
      pendingResults.map((pending, index) =>
        pending
          ? readers[index]?.markJobResultProcessed({
              jobResultId: pending.jobResult.id,
              now: processedAt
            })
          : Promise.resolve()
      )
    );

    expect(database.processedResultIds().sort()).toEqual(claimedResultIds.sort());
  });

  it("marks a claimed transition result as processed", async () => {
    const database = new FakeMysqlDatabase();
    const reader = new MysqlRepositoryTransitionWorkReader(database, {
      workerId: "transition-worker-a"
    });
    database.queueResult({ affectedRows: 1 });

    await reader.markJobResultProcessed({
      jobResultId: "result_1",
      now: new Date("2026-05-21T00:03:00.000Z")
    });

    expect(database.statements[0]).toMatchObject({
      sql: expect.stringContaining("UPDATE workflow_transition_claim"),
      params: [
        "processed",
        "2026-05-21 00:03:00.000",
        "2026-05-21 00:03:00.000",
        "result_1",
        "transition-worker-a",
        "claimed"
      ]
    });
    expect(database.statements[0]?.sql).toContain("WHERE workflow_job_result_id = ?");
    expect(database.statements[0]?.sql).toContain("claimed_by_worker_id = ?");
    expect(database.statements[0]?.sql).toContain("status = ?");
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

interface TransitionClaim {
  status: string;
  claimedByWorkerId: string;
  leaseExpiresAt: string;
  processedAt?: string;
}

class ConcurrentTransitionMysqlDatabase implements MysqlDatabase {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  private readonly claims = new Map<string, TransitionClaim>();

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    const normalized = normalizeSql(sql);
    this.statements.push({ sql: normalized, params });

    if (normalized.includes("FROM workflow_job_result result")) {
      const nowIso = stringValue(params[1]);
      return [[this.oldestVisibleResult(nowIso)].filter(Boolean) as T, undefined];
    }

    if (normalized.includes("INSERT INTO workflow_transition_claim")) {
      const resultId = stringValue(params[0]);
      const claim = this.claims.get(resultId);
      const claimedAt = stringValue(params[5]);

      if (!claim || (claim.status !== "processed" && claim.leaseExpiresAt <= claimedAt)) {
        this.claims.set(resultId, {
          status: stringValue(params[3]),
          claimedByWorkerId: stringValue(params[4]),
          leaseExpiresAt: stringValue(params[6])
        });
        return [{ affectedRows: claim ? 2 : 1 } as T, undefined];
      }

      return [{ affectedRows: 0 } as T, undefined];
    }

    if (normalized.includes("UPDATE workflow_transition_claim")) {
      const resultId = stringValue(params[3]);
      const workerId = stringValue(params[4]);
      const requiredStatus = stringValue(params[5]);
      const claim = this.claims.get(resultId);

      if (claim?.claimedByWorkerId === workerId && claim.status === requiredStatus) {
        claim.status = stringValue(params[0]);
        claim.processedAt = stringValue(params[1]);
        return [{ affectedRows: 1 } as T, undefined];
      }

      return [{ affectedRows: 0 } as T, undefined];
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  async getConnection(): Promise<never> {
    throw new Error("reader does not need a transaction connection");
  }

  processedResultIds(): string[] {
    return Array.from(this.claims.entries()).flatMap(([resultId, claim]) =>
      claim.status === "processed" ? [resultId] : []
    );
  }

  private oldestVisibleResult(nowIso: string): Record<string, unknown> | undefined {
    return this.rows
      .filter((row) => {
        const claim = this.claims.get(stringValue(row.result_id));
        return !claim || (claim.status !== "processed" && claim.leaseExpiresAt <= nowIso);
      })
      .sort((left, right) => {
        const byCreatedAt = stringValue(left.result_created_at).localeCompare(stringValue(right.result_created_at));
        return byCreatedAt === 0
          ? stringValue(left.result_id).localeCompare(stringValue(right.result_id))
          : byCreatedAt;
      })[0];
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string value, got: ${String(value)}`);
  }

  return value;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
