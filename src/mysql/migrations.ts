import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MysqlConnection, MysqlDatabase } from "../workflow-core/mysql-repository";

export interface MysqlMigration {
  version: string;
  filename: string;
  sql: string;
  statements: string[];
}

export interface AppliedMysqlMigration {
  version: string;
  statementCount: number;
}

const SCHEMA_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS schema_migration (
  version VARCHAR(128) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)`;

export async function loadMysqlMigrations(
  migrationsDir = path.join(process.cwd(), "migrations", "mysql")
): Promise<MysqlMigration[]> {
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(path.join(migrationsDir, filename), "utf8");

      return {
        version: filename.replace(/\.sql$/, ""),
        filename,
        sql,
        statements: splitMysqlStatements(sql)
      };
    })
  );
}

export async function applyMysqlMigrations(
  database: MysqlDatabase,
  migrations: MysqlMigration[]
): Promise<AppliedMysqlMigration[]> {
  const connection = await database.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(SCHEMA_MIGRATION_SQL);

    const appliedVersions = await getAppliedVersions(connection);
    const applied: AppliedMysqlMigration[] = [];

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      for (const statement of migration.statements) {
        await connection.execute(statement);
      }

      await connection.execute("INSERT INTO schema_migration (version) VALUES (?)", [migration.version]);
      appliedVersions.add(migration.version);
      applied.push({
        version: migration.version,
        statementCount: migration.statements.length
      });
    }

    await connection.commit();
    return applied;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function splitMysqlStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;

  for (let index = 0; index < withoutLineComments.length; index += 1) {
    const char = withoutLineComments[index];
    const previous = withoutLineComments[index - 1];

    if ((char === "'" || char === '"' || char === "`") && previous !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }

    if (char === ";" && !quote) {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const finalStatement = current.trim();
  if (finalStatement.length > 0) {
    statements.push(finalStatement);
  }

  return statements;
}

async function getAppliedVersions(connection: MysqlConnection): Promise<Set<string>> {
  const [rows] = await connection.execute<Array<{ version: string }>>(
    "SELECT version FROM schema_migration ORDER BY version ASC"
  );

  return new Set(rows.map((row) => row.version));
}
