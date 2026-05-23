import { describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../backend/src/legacy/prd-confirmation/fixture";
import { createGenericPrdSnapshot } from "../backend/src/legacy/prd-confirmation/generic-adapter";
import { MysqlPrdSnapshotMirror } from "../backend/src/legacy/prd-confirmation/mysql-snapshot-mirror";
import type { MysqlConnection, MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";

describe("MysqlPrdSnapshotMirror", () => {
  it("mirrors fixture workflow snapshots into MySQL read-model tables in dependency order", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.runUntilIdle();
    await fixture.workflow.requestFeedbackRevision("PRD-100", {
      requestedBy: "planner@example.com",
      feedback: "Add measurable rollout KPI.",
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    const database = new FakeMysqlDatabase();
    const mirror = new MysqlPrdSnapshotMirror(database);

    await mirror.persist(createGenericPrdSnapshot(fixture.store));

    expect(database.statements.map((statement) => statement.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO workflow_run"),
        expect.stringContaining("INSERT INTO workflow_task"),
        expect.stringContaining("INSERT INTO workflow_job"),
        expect.stringContaining("INSERT INTO workflow_job_result"),
        expect.stringContaining("INSERT INTO document"),
        expect.stringContaining("INSERT INTO document_version"),
        expect.stringContaining("INSERT INTO artifact"),
        expect.stringContaining("UPDATE document SET status"),
        expect.stringContaining("INSERT INTO quality_gate_result"),
        expect.stringContaining("INSERT INTO feedback_item")
      ])
    );
    expect(indexOfSql(database, "INSERT INTO workflow_run")).toBeLessThan(indexOfSql(database, "INSERT INTO workflow_task"));
    expect(indexOfSql(database, "INSERT INTO workflow_task")).toBeLessThan(indexOfSql(database, "INSERT INTO workflow_job"));
    expect(indexOfSql(database, "INSERT INTO workflow_job")).toBeLessThan(indexOfSql(database, "INSERT INTO document_version"));
    expect(indexOfSql(database, "INSERT INTO document_version")).toBeLessThan(indexOfSql(database, "INSERT INTO artifact"));
    expect(indexOfSql(database, "INSERT INTO artifact")).toBeLessThan(indexOfSql(database, "UPDATE document SET status"));
    expect(database.statements.find((statement) => statement.sql.includes("INSERT INTO workflow_job"))?.sql).toContain(
      "task_id"
    );
    expect(database.statements.find((statement) => statement.sql.includes("INSERT INTO document"))?.sql).toContain(
      "workflow_task_id"
    );
    expect(
      database.statements.find((statement) => statement.sql.includes("INSERT INTO feedback_item"))?.params
    ).toContain("Add measurable rollout KPI.");
  });
});

class FakeMysqlDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });
    return [{ affectedRows: 1 } as T, undefined];
  }

  async getConnection(): Promise<MysqlConnection> {
    return this;
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  release(): void {}
}

function indexOfSql(database: FakeMysqlDatabase, pattern: string): number {
  const index = database.statements.findIndex((statement) => statement.sql.includes(pattern));

  if (index < 0) {
    throw new Error(`Missing SQL pattern: ${pattern}`);
  }

  return index;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
