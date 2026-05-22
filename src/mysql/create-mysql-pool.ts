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
  const pool = mysql.createPool({
    host: env.WORKFLOW_MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.WORKFLOW_MYSQL_PORT ?? 3306),
    database: env.WORKFLOW_MYSQL_DATABASE ?? "ai_workflow",
    user: env.WORKFLOW_MYSQL_USER ?? "ai_workflow",
    password: env.WORKFLOW_MYSQL_PASSWORD ?? "ai_workflow",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: 10
  });

  return {
    async execute<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]> {
      const [rows, fields] = await pool.execute(sql, params as any);
      return [rows as T, fields];
    },
    async getConnection() {
      const connection = await pool.getConnection();

      return {
        async execute<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]> {
          const [rows, fields] = await connection.execute(sql, params as any);
          return [rows as T, fields];
        },
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release()
      };
    },
    end: () => pool.end()
  };
}
