import { describe, expect, it } from "vitest";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";
import {
  MysqlWorkflowRepository,
  rowToRunner,
  rowToWorkflowEvent,
  rowToWorkflowJob,
  rowToWorkflowTask
} from "../src/workflow-core/mysql-repository";

describe("MysqlWorkflowRepository", () => {
  it("inserts workflow runs and jobs through the repository contract", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database, { idGenerator: fixedIds("run_1", "job_1") });
    const now = new Date("2026-05-20T00:00:00.000Z");

    const run = await repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const job = await repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });

    expect(run).toMatchObject({
      id: "run_1",
      workflowDefinitionId: "prd_to_spec",
      sourceKey: "PRD-100"
    });
    expect(job).toMatchObject({
      id: "job_1",
      status: "pending",
      executionPolicy: "local_allowed"
    });
    expect(database.statements[0]?.sql).toContain("INSERT INTO workflow_run");
    expect(database.statements[1]?.sql).toContain("INSERT INTO workflow_job");
    expect(database.statements[1]?.params).toContain(JSON.stringify(["document.generate"]));
  });

  it("inserts workflow tasks and links jobs to the task", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database, { idGenerator: fixedIds("task_1", "job_1") });
    const now = new Date("2026-05-20T00:00:00.000Z");

    const task = await repository.createWorkflowTask({
      runId: "run_1",
      taskType: "prd",
      sourceKey: "PRD-100",
      title: "FAQ automation PRD",
      currentDocumentId: "doc_1",
      now
    });
    const job = await repository.createWorkflowJob({
      runId: "run_1",
      taskId: task.id,
      jobType: "prd.generate_draft",
      now
    });

    expect(task).toMatchObject({
      id: "task_1",
      runId: "run_1",
      currentDocumentId: "doc_1"
    });
    expect(job.taskId).toBe("task_1");
    expect(database.statements[0]?.sql).toContain("INSERT INTO workflow_task");
    expect(database.statements[1]?.sql).toContain("task_id");
    expect(database.statements[1]?.params).toContain("task_1");
  });

  it("lists workflow jobs for a run in stable creation order", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    database.queueRows([
      workflowJobRow({ id: "job_1", run_id: "run_1", task_id: "task_1" }),
      workflowJobRow({
        id: "job_2",
        run_id: "run_1",
        task_id: "task_1",
        created_at: "2026-05-20T00:00:01.000Z",
        updated_at: "2026-05-20T00:00:01.000Z"
      })
    ]);

    const jobs = await repository.listWorkflowJobs("run_1");

    expect(jobs.map((job) => job.id)).toEqual(["job_1", "job_2"]);
    expect(database.statements[0]).toMatchObject({
      sql: expect.stringContaining("FROM workflow_job WHERE run_id = ? ORDER BY created_at ASC, id ASC"),
      params: ["run_1"]
    });
  });

  it("claims an eligible job inside a transaction using runner scope and capabilities", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([runnerRow()]);
    database.queueRows([{ active_job_count: 0 }]);
    database.queueRows([
      workflowJobRow({ id: "job_other", assigned_user_id: "other-user" }),
      workflowJobRow({ id: "job_eligible", assigned_user_id: "planner-a" })
    ]);
    database.queueResult({ affectedRows: 1 });

    const claim = await repository.claimNextJob({
      runnerId: "runner-planner-a",
      now,
      leaseMs: 60_000
    });

    expect(claim?.job).toMatchObject({
      id: "job_eligible",
      status: "claimed",
      claimedByRunnerId: "runner-planner-a",
      leaseExpiresAt: "2026-05-20T00:01:00.000Z"
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM runner"),
      expect.stringContaining("COUNT(*) AS active_job_count"),
      expect.stringContaining("SELECT * FROM workflow_job"),
      expect.stringContaining("UPDATE workflow_job")
    ]);
    expect(database.statements[0]?.sql).toContain("FOR UPDATE");
    expect(database.statements[2]?.sql).toContain("FOR UPDATE");
  });

  it("lists runners ordered by recent heartbeat for dashboard visibility", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    database.queueRows([
      runnerRow({ id: "runner-new", last_heartbeat_at: "2026-05-20T00:00:05.000Z" }),
      runnerRow({ id: "runner-old", last_heartbeat_at: "2026-05-20T00:00:00.000Z" })
    ]);

    const runners = await repository.listRunners();

    expect(runners.map((runner) => runner.id)).toEqual(["runner-new", "runner-old"]);
    expect(database.statements[0]?.sql).toContain("ORDER BY last_heartbeat_at DESC, id ASC");
  });

  it("keeps disabled runners paused across registration and resumes them explicitly", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueResult({ affectedRows: 1 });
    database.queueRows([runnerRow({ status: "disabled" })]);
    database.queueResult({ affectedRows: 1 });
    database.queueRows([runnerRow({ status: "online", last_heartbeat_at: "2026-05-20 00:00:05.000" })]);

    const registered = await repository.upsertRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      status: "online",
      teamIds: ["planning"],
      allowedProjectIds: ["pair"],
      allowedRepositoryIds: ["prd-docs"],
      capabilities: ["document.generate"],
      engines: ["claude"],
      defaultEngine: "claude",
      concurrency: 1,
      lastHeartbeatAt: now.toISOString()
    });
    const resumed = await repository.setRunnerStatus(
      "runner-planner-a",
      "online",
      new Date("2026-05-20T00:00:05.000Z")
    );

    expect(registered.status).toBe("disabled");
    expect(resumed.status).toBe("online");
    expect(database.statements[0]?.sql).toContain("CASE WHEN status = 'disabled' THEN 'disabled'");
    expect(database.statements[2]?.sql).toContain("UPDATE runner SET status = ?");
  });

  it("does not select another job when the runner is at concurrency capacity", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([runnerRow({ concurrency: 1 })]);
    database.queueRows([{ active_job_count: 1 }]);

    const claim = await repository.claimNextJob({
      runnerId: "runner-planner-a",
      now,
      leaseMs: 60_000
    });

    expect(claim).toBeUndefined();
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM runner"),
      expect.stringContaining("COUNT(*) AS active_job_count")
    ]);
  });

  it("does not select work for a runner with a stale heartbeat", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    database.queueRows([
      runnerRow({
        last_heartbeat_at: "2026-05-20T00:00:00.000Z"
      })
    ]);

    const claim = await repository.claimNextJob({
      runnerId: "runner-planner-a",
      now: new Date("2026-05-20T00:01:01.000Z"),
      leaseMs: 60_000,
      runnerOfflineAfterMs: 60_000
    });

    expect(claim).toBeUndefined();
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM runner")
    ]);
  });

  it("diagnoses pending jobs that do not match the runner scope", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([runnerRow()]);
    database.queueRows([{ active_job_count: 0 }]);
    database.queueRows([workflowJobRow({ id: "job_other", assigned_user_id: "other-user" })]);

    const diagnostics = await repository.diagnoseClaim({
      runnerId: "runner-planner-a",
      now,
      leaseMs: 60_000
    });

    expect(diagnostics).toMatchObject({
      runnerId: "runner-planner-a",
      reason: "no_matching_job",
      runnerStatus: "online",
      activeJobCount: 0,
      concurrency: 1,
      candidateJobCount: 1,
      nearestJobId: "job_other",
      nearestBlocker: "owner_mismatch"
    });
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM runner"),
      expect.stringContaining("COUNT(*) AS active_job_count"),
      expect.stringContaining("SELECT * FROM workflow_job")
    ]);
    expect(database.statements[2]?.sql).not.toContain("FOR UPDATE");
  });

  it("diagnoses when a matching job is available for a runner", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([runnerRow()]);
    database.queueRows([{ active_job_count: 0 }]);
    database.queueRows([workflowJobRow({ id: "job_available" })]);

    const diagnostics = await repository.diagnoseClaim({
      runnerId: "runner-planner-a",
      now,
      leaseMs: 60_000
    });

    expect(diagnostics).toMatchObject({
      runnerId: "runner-planner-a",
      reason: "claim_available",
      runnerStatus: "online",
      activeJobCount: 0,
      concurrency: 1,
      candidateJobCount: 1,
      nearestJobId: "job_available"
    });
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM runner"),
      expect.stringContaining("COUNT(*) AS active_job_count"),
      expect.stringContaining("SELECT * FROM workflow_job")
    ]);
    expect(database.statements[2]?.sql).not.toContain("FOR UPDATE");
  });

  it("records retryable failures as result attempts and releases the claim", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database, { idGenerator: fixedIds("result_1") });
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([workflowJobRow({ id: "job_1", status: "running", claimed_by_runner_id: "runner-a" })]);
    database.queueRows([{ next_attempt_no: 2 }]);
    database.queueResult({ affectedRows: 1 });
    database.queueResult({ affectedRows: 1 });

    const result = await repository.failJob({
      jobId: "job_1",
      runnerId: "runner-a",
      output: { status: "failed" },
      errorCode: "timeout",
      errorMessage: "Engine timed out",
      retryable: true,
      now
    });

    expect(result).toMatchObject({
      id: "result_1",
      jobId: "job_1",
      attemptNo: 2,
      status: "failed",
      errorCode: "timeout"
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements[2]?.sql).toContain("INSERT INTO workflow_job_result");
    expect(database.statements[3]?.sql).toContain("claimed_by_runner_id = NULL");
    expect(database.statements[3]?.params).toContain("retrying");
  });

  it("requests and acknowledges cancellation in transactions", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database, { idGenerator: fixedIds("result_1") });
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([workflowJobRow({ status: "running", claimed_by_runner_id: "runner-a" })]);
    database.queueResult({ affectedRows: 1 });

    const cancelRequested = await repository.requestJobCancellation({
      jobId: "job_1",
      requestedBy: "planner-a",
      reason: "Superseded",
      now
    });

    expect(cancelRequested).toMatchObject({
      id: "job_1",
      status: "cancel_requested",
      claimedByRunnerId: "runner-a"
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements[0]?.sql).toContain("FOR UPDATE");
    expect(database.statements[1]).toMatchObject({
      sql: expect.stringContaining("SET status = ?"),
      params: ["cancel_requested", "2026-05-20 00:00:00.000", "job_1"]
    });

    const ackDatabase = new FakeMysqlDatabase();
    const ackRepository = new MysqlWorkflowRepository(ackDatabase, { idGenerator: fixedIds("result_1") });
    ackDatabase.queueRows([
      workflowJobRow({ status: "cancel_requested", claimed_by_runner_id: "runner-a" })
    ]);
    ackDatabase.queueRows([{ next_attempt_no: 1 }]);
    ackDatabase.queueResult({ affectedRows: 1 });
    ackDatabase.queueResult({ affectedRows: 1 });

    const canceled = await ackRepository.acknowledgeJobCancellation({
      jobId: "job_1",
      runnerId: "runner-a",
      output: { status: "canceled" },
      now
    });

    expect(canceled).toMatchObject({
      id: "result_1",
      jobId: "job_1",
      status: "canceled",
      output: { status: "canceled" }
    });
    expect(ackDatabase.events).toEqual(["begin", "commit", "release"]);
    expect(ackDatabase.statements[2]?.sql).toContain("INSERT INTO workflow_job_result");
    expect(ackDatabase.statements[3]?.sql).toContain("status = 'canceled'");
  });

  it("manually retries terminal jobs in a transaction", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    const now = new Date("2026-05-20T00:00:00.000Z");
    database.queueRows([
      workflowJobRow({
        id: "job_1",
        status: "failed",
        claimed_by_runner_id: "runner-a",
        claimed_at: "2026-05-20 00:00:00.000",
        lease_expires_at: "2026-05-20 00:01:00.000"
      })
    ]);
    database.queueResult({ affectedRows: 1 });

    const retried = await repository.requestJobRetry({
      jobId: "job_1",
      requestedBy: "planner-a",
      reason: "Manual retry",
      now
    });

    expect(retried).toMatchObject({
      id: "job_1",
      status: "retrying",
      claimedByRunnerId: undefined,
      claimedAt: undefined,
      leaseExpiresAt: undefined
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements[0]?.sql).toContain("FOR UPDATE");
    expect(database.statements[1]).toMatchObject({
      sql: expect.stringContaining("SET status = 'retrying'"),
      params: ["2026-05-20 00:00:00.000", "job_1"]
    });
  });

  it("lists runner log events with job/type filters and a limit", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlWorkflowRepository(database);
    database.queueRows([workflowEventRow()]);

    const events = await repository.listWorkflowEvents({
      jobId: "job_1",
      type: "runner.log",
      after: {
        createdAt: "2026-05-20T00:00:00.000Z",
        id: "event_0"
      },
      limit: 1
    });

    expect(events).toEqual([
      {
        id: "event_1",
        runId: "run_1",
        jobId: "job_1",
        type: "runner.log",
        message: "Preparing workspace",
        metadata: {
          level: "info",
          runnerId: "runner-planner-a"
        },
        createdAt: "2026-05-20T00:00:01.000Z"
      }
    ]);
    expect(database.statements[0]).toMatchObject({
      sql: expect.stringContaining("WHERE job_id = ? AND type = ? AND (created_at > ? OR (created_at = ? AND id > ?))"),
      params: ["job_1", "runner.log", "2026-05-20 00:00:00.000", "2026-05-20 00:00:00.000", "event_0", 1]
    });
  });

  it("maps MySQL rows into domain objects", () => {
    expect(rowToRunner(runnerRow())).toMatchObject({
      id: "runner-planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"]
    });
    expect(rowToWorkflowJob(workflowJobRow())).toMatchObject({
      id: "job_1",
      taskId: undefined,
      status: "pending",
      input: { sourceKey: "PRD-100" },
      requiredCapabilities: ["document.generate"]
    });
    expect(rowToWorkflowTask(workflowTaskRow())).toMatchObject({
      id: "task_1",
      runId: "run_1",
      taskType: "prd",
      currentDocumentId: "doc_wi_1"
    });
    expect(rowToWorkflowEvent(workflowEventRow())).toMatchObject({
      id: "event_1",
      jobId: "job_1",
      metadata: {
        level: "info"
      }
    });
  });
});

class FakeMysqlDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly events: string[] = [];
  private readonly responses: unknown[] = [];

  queueRows(rows: unknown[]): void {
    this.responses.push(rows);
  }

  queueResult(result: unknown): void {
    this.responses.push(result);
  }

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });
    return [(this.responses.shift() ?? { affectedRows: 1 }) as T, undefined];
  }

  async getConnection(): Promise<MysqlConnection> {
    return this;
  }

  async beginTransaction(): Promise<void> {
    this.events.push("begin");
  }

  async commit(): Promise<void> {
    this.events.push("commit");
  }

  async rollback(): Promise<void> {
    this.events.push("rollback");
  }

  release(): void {
    this.events.push("release");
  }
}

function runnerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "runner-planner-a",
    owner_user_id: "planner-a",
    mode: "local",
    status: "online",
    team_ids_json: JSON.stringify(["planning"]),
    allowed_project_ids_json: JSON.stringify(["pair"]),
    allowed_repository_ids_json: JSON.stringify(["prd-docs"]),
    capabilities_json: JSON.stringify(["document.generate"]),
    engines_json: JSON.stringify(["claude"]),
    default_engine: "claude",
    concurrency: 1,
    last_heartbeat_at: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function workflowJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job_1",
    run_id: "run_1",
    task_id: null,
    job_type: "document.generate",
    status: "pending",
    input_json: JSON.stringify({ sourceKey: "PRD-100" }),
    priority: 0,
    project_id: "pair",
    repository_id: "prd-docs",
    assigned_user_id: "planner-a",
    assigned_team_id: null,
    required_role: "planner",
    required_capabilities_json: JSON.stringify(["document.generate"]),
    preferred_engine: null,
    required_engine: "claude",
    execution_policy: "local_allowed",
    assigned_runner_id: null,
    claimed_by_runner_id: null,
    claimed_at: null,
    lease_expires_at: null,
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function workflowTaskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_1",
    run_id: "run_1",
    parent_task_id: null,
    task_type: "prd",
    source_key: "PRD-100",
    title: "FAQ automation PRD",
    status: "draft",
    current_document_id: "doc_wi_1",
    metadata_json: JSON.stringify({ documentId: "doc_wi_1" }),
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function workflowEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event_1",
    run_id: "run_1",
    job_id: "job_1",
    type: "runner.log",
    message: "Preparing workspace",
    metadata_json: JSON.stringify({
      level: "info",
      runnerId: "runner-planner-a"
    }),
    created_at: "2026-05-20T00:00:01.000Z",
    ...overrides
  };
}

function fixedIds(...ids: string[]): (prefix: string) => string {
  let index = 0;
  return (prefix) => ids[index++] ?? `${prefix}_${index}`;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
