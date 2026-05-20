import "dotenv/config";
import { applyMysqlMigrations, loadMysqlMigrations } from "./migrations";
import { createWorkflowMysqlPoolFromEnv } from "./create-mysql-pool";

const database = createWorkflowMysqlPoolFromEnv(process.env);

try {
  const migrations = await loadMysqlMigrations();
  const applied = await applyMysqlMigrations(database, migrations);

  if (applied.length === 0) {
    console.log("MySQL migrations already up to date.");
  } else {
    for (const migration of applied) {
      console.log(`Applied ${migration.version} (${migration.statementCount} statements).`);
    }
  }
} finally {
  const maybePool = database as { end?: () => Promise<void> };
  await maybePool.end?.();
}
