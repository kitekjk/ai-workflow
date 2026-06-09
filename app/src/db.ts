import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { ExecuteValues } from "mysql2";
import type { MysqlConfig } from "./config";

/** F5: store all datetimes as UTC 'YYYY-MM-DD HH:mm:ss'. ISO 'Z' never reaches MySQL raw. */
export function toMysqlDatetime(iso: string | null): string | null {
  if (iso === null) return null;
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

export function fromMysqlDatetime(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  // MySQL DATETIME comes back as 'YYYY-MM-DD HH:mm:ss' (UTC by our convention).
  return new Date(value.replace(" ", "T") + "Z").toISOString();
}

/** F6: mysql2 cannot bind LIMIT as a placeholder. Validate then inline an integer. */
export function safeLimit(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid LIMIT: ${n}`);
  }
  return n;
}

/** Single persistence boundary (NFR-4). All MySQL access goes through here. */
export class Db {
  private constructor(private readonly pool: Pool) {}

  static fromConfig(cfg: MysqlConfig): Db {
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      timezone: "Z", // interpret/emit DATETIME as UTC
      connectionLimit: 4,
    });
    return new Db(pool);
  }

  async query<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query<T[]>(sql, params as ExecuteValues[]);
    return rows;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.execute(sql, params as ExecuteValues[]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
