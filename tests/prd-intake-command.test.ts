import { describe, expect, it } from "vitest";
import {
  MysqlPrdIntakeCommand,
  MysqlWorkflowIntakeCommand
} from "../backend/src/workflow-api/prd-intake-command";
import type { MysqlConnection, MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";

describe("MysqlPrdIntakeCommand", () => {
  it("records PRD intake as a direct MySQL workflow/document/job command", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlPrdIntakeCommand(database, { idGenerator: fixedIds("event_1") });

    const result = await command.recordIntake({
      runId: "run_1",
      workItemId: "wi_1",
      jobId: "job_1",
      prdJiraKey: "PRD-100",
      title: "FAQ automation PRD",
      requestedBy: "planner@example.com",
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(result).toEqual({
      runId: "run_1",
      documentId: "doc_wi_1",
      jobId: "job_1"
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO workflow_run"),
      expect.stringContaining("INSERT INTO workflow_task"),
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toContain("PRD-100");
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining(["task_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "draft", "doc_wi_1"])
    );
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining(["doc_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "draft"])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining([
        "job_1",
        "run_1",
        "task_wi_1",
        "prd.generate_draft",
        "pending",
        "planner@example.com",
        "planner",
        "local_allowed"
      ])
    );
    expect(database.statements[4].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "job_1",
        "workflow.prd_intake",
        "PRD intake recorded: PRD-100"
      ])
    );
    expect(JSON.parse(String(database.statements[4].params[5]))).toEqual({
      runId: "run_1",
      taskId: "task_wi_1",
      documentId: "doc_wi_1",
      jobId: "job_1",
      prdJiraKey: "PRD-100",
      title: "FAQ automation PRD",
      requestedBy: "planner@example.com"
    });
  });

  it("rolls back and releases the connection when recording intake fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 2 });
    const command = new MysqlPrdIntakeCommand(database);

    await expect(
      command.recordIntake({
        runId: "run_1",
        workItemId: "wi_1",
        jobId: "job_1",
        prdJiraKey: "PRD-100"
      })
    ).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });

  it("records non-PRD workflow intake as a generic document generate task", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowIntakeCommand(database, { idGenerator: fixedIds("event_1") });

    const result = await command.recordIntake({
      runId: "run_hld_1",
      workItemId: "wi_hld_1",
      jobId: "job_hld_1",
      sourceType: "app",
      sourceKey: "HLD-APP-1",
      documentType: "hld",
      workflowDefinitionId: "hld_to_spec",
      title: "Manual HLD seed",
      requestedBy: "developer@example.com",
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(result).toEqual({
      runId: "run_hld_1",
      documentId: "doc_wi_hld_1",
      jobId: "job_hld_1"
    });
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining(["run_hld_1", "hld_to_spec", "active", "app", "HLD-APP-1", "ko"])
    );
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining(["task_wi_hld_1", "run_hld_1", "hld", "HLD-APP-1", "Manual HLD seed"])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining([
        "job_hld_1",
        "run_hld_1",
        "task_wi_hld_1",
        "document.generate",
        "pending",
        "developer@example.com",
        "developer",
        "local_allowed"
      ])
    );
    expect(JSON.parse(String(database.statements[3].params[5]))).toMatchObject({
      sourceType: "app",
      sourceKey: "HLD-APP-1",
      documentType: "hld",
      workflowDefinitionId: "hld_to_spec",
      title: "Manual HLD seed",
      requestedBy: "developer@example.com"
    });
    expect(database.statements[4].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_hld_1",
        "job_hld_1",
        "workflow.source_intake",
        "Workflow source intake recorded: HLD-APP-1"
      ])
    );
  });
});

class FakeMysqlDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly events: string[] = [];

  constructor(private readonly options: { failOnStatement?: number } = {}) {}

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });

    if (this.options.failOnStatement === this.statements.length) {
      throw new Error("forced database failure");
    }

    return [{ affectedRows: 1 } as T, undefined];
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

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function fixedIds(...ids: string[]): () => string {
  let index = 0;

  return () => ids[index++] ?? ids.at(-1) ?? "generated_id";
}
