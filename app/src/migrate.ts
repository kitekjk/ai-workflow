import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { mysqlConfigFromEnv } from "./config";

async function main(): Promise<void> {
  const cfg = mysqlConfigFromEnv();
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "../migrations/001_init.sql"), "utf8");
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  console.log("migration 001 applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
