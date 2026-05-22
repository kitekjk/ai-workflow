import { describe, expect, it } from "vitest";
import type { MysqlConnection, MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";
import { applyMysqlMigrations, splitMysqlStatements, type MysqlMigration } from "../backend/src/mysql/migrations";

describe("MySQL migration runner", () => {
  it("splits SQL statements while preserving semicolons inside strings", () => {
    expect(
      splitMysqlStatements(`
        -- ignored comment
        CREATE TABLE example (id VARCHAR(64));
        INSERT INTO example (id) VALUES ('semi;colon');
      `)
    ).toEqual([
      "CREATE TABLE example (id VARCHAR(64))",
      "INSERT INTO example (id) VALUES ('semi;colon')"
    ]);
  });

  it("applies only migrations that are not recorded in schema_migration", async () => {
    const database = new FakeMigrationDatabase();
    database.queueRows([{ version: "001_existing" }]);

    const applied = await applyMysqlMigrations(database, [
      migration("001_existing", "CREATE TABLE already_done (id INT);"),
      migration("002_next", "CREATE TABLE next_table (id INT); CREATE TABLE next_table_2 (id INT);")
    ]);

    expect(applied).toEqual([{ version: "002_next", statementCount: 2 }]);
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migration"),
      "SELECT version FROM schema_migration ORDER BY version ASC",
      "CREATE TABLE next_table (id INT)",
      "CREATE TABLE next_table_2 (id INT)",
      "INSERT INTO schema_migration (version) VALUES (?)"
    ]);
    expect(database.statements.at(-1)?.params).toEqual(["002_next"]);
  });

  it("rolls back and releases the connection when a migration statement fails", async () => {
    const database = new FakeMigrationDatabase({ failOn: "CREATE TABLE broken" });
    database.queueRows([]);

    await expect(
      applyMysqlMigrations(database, [migration("001_broken", "CREATE TABLE broken (id INT);")])
    ).rejects.toThrow(/Forced failure/);

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });
});

class FakeMigrationDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly events: string[] = [];
  private readonly responses: unknown[] = [];

  constructor(private readonly options: { failOn?: string } = {}) {}

  queueRows(rows: unknown[]): void {
    this.responses.push(rows);
  }

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    const normalized = normalizeSql(sql);

    if (this.options.failOn && normalized.includes(this.options.failOn)) {
      throw new Error(`Forced failure for ${this.options.failOn}`);
    }

    this.statements.push({ sql: normalized, params });
    const result = normalized.toUpperCase().startsWith("SELECT")
      ? this.responses.shift() ?? []
      : { affectedRows: 1 };
    return [result as T, undefined];
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

function migration(version: string, sql: string): MysqlMigration {
  return {
    version,
    filename: `${version}.sql`,
    sql,
    statements: splitMysqlStatements(sql)
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
