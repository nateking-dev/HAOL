import mysql, { type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";
import { type DoltConfig } from "../config.js";

let pool: Pool | null = null;

export function createPool(config: DoltConfig): Pool {
  const opts: PoolOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.poolSize,
    waitForConnections: true,
  };
  pool = mysql.createPool(opts);
  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error("Database pool not initialized. Call createPool() first.");
  }
  return pool;
}

export async function query<T extends RowDataPacket[]>(
  sql: string,
  params?: unknown[],
): Promise<T> {
  const p = getPool();
  const [rows] = await p.query<T>(sql, params);
  return rows;
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  const p = getPool();
  await p.execute(sql, params as (string | number | null)[] | undefined);
}

export async function healthCheck(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function destroy(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
