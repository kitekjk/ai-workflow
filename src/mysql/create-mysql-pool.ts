import mysql from "mysql2/promise";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";

export interface MysqlPoolEnv {
  WORKFLOW_MYSQL_HOST?: string;
  WORKFLOW_MYSQL_PORT?: string;
  WORKFLOW_MYSQL_DATABASE?: string;
  WORKFLOW_MYSQL_USER?: string;
  WORKFLOW_MYSQL_PASSWORD?: string;
}

export function createWorkflowMysqlPoolFromEnv(env: MysqlPoolEnv): MysqlDatabase {
  return mysql.createPool({
    host: env.WORKFLOW_MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.WORKFLOW_MYSQL_PORT ?? 3306),
    database: env.WORKFLOW_MYSQL_DATABASE ?? "ai_workflow",
    user: env.WORKFLOW_MYSQL_USER ?? "ai_workflow",
    password: env.WORKFLOW_MYSQL_PASSWORD ?? "ai_workflow",
    waitForConnections: true,
    connectionLimit: 10
  });
}
