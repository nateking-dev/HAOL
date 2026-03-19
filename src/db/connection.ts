import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type RowDataPacket,
} from "mysql2/promise";
import { type DoltConfig } from "../config.js";

export type Queryable = Pool | PoolConnection;

export const DEFAULT_BRANCH = process.env.DOLT_DEFAULT_BRANCH ?? "main";

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

/**
 * Acquire a dedicated connection, run `fn`, and release it.
 * No branch reset — use this for callers that never switch branches
 * (commits, read-only queries, etc.) to avoid an extra round-trip.
 */
export async function withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

/**
 * Acquire a dedicated connection with branch-safety guarantees.
 * The finally block resets the connection to the default branch before
 * returning it to the pool, preventing branch-corruption bugs when the
 * callback uses doltCheckout/doltMerge. Use this instead of
 * withConnection when the callback may switch branches.
 */
export async function withBranchConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    return await fn(conn);
  } finally {
    try {
      await conn.query("CALL DOLT_CHECKOUT(?)", [DEFAULT_BRANCH]);
    } catch {
      // The connection may already be on the default branch, or broken.
      // Either way we still release it.
    }
    conn.release();
  }
}

export async function destroy(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
