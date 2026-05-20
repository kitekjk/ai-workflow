import { describe, expect, it } from "vitest";
import { MysqlPrdIntakeCommand } from "../src/workflow-api/prd-intake-command";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlPrdIntakeCommand", () => {
  it("records PRD intake as a direct MySQL workflow/document/job command", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlPrdIntakeCommand(database);

    const result = await command.recordIntake({
      runId: "run_1",
      workItemId: "wi_1",
      jobId: "job_1",
      prdJiraKey: "PRD-100",
      title: "FAQ automation PRD",
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
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job")
    ]);
    expect(database.statements[0].params).toContain("PRD-100");
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining(["doc_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "draft"])
    );
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining(["job_1", "run_1", "prd.generate_draft", "pending", "planner", "local_allowed"])
    );
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
