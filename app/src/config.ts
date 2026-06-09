export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function mysqlConfigFromEnv(env = process.env): MysqlConfig {
  return {
    host: env.WORKFLOW_MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.WORKFLOW_MYSQL_PORT ?? "3306"),
    user: env.WORKFLOW_MYSQL_USER ?? "ai_workflow",
    password: env.WORKFLOW_MYSQL_PASSWORD ?? "ai_workflow",
    database: env.WORKFLOW_MYSQL_DATABASE ?? "ai_workflow",
  };
}
