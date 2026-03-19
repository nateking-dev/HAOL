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
 * The finally block always resets the connection to the default branch
 * before returning it to the pool. This adds one round-trip per call,
 * even for read-only callbacks that never switch branches — an acceptable
 * cost for preventing branch-corruption bugs in the shared pool.
 */
export async function withConnection<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    return await fn(conn);
  } finally {
    // Best-effort: reset connection to main branch before returning it
    // to the pool. If the callback checked out a different branch and
    // then threw, this prevents subsequent pool users from operating
    // on the wrong branch.
    try {
      await conn.query("CALL DOLT_CHECKOUT(?)", [DEFAULT_BRANCH]);
    } catch {
      // ignore — the connection may already be on main, or the
      // connection may be broken; either way we still release it.
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
