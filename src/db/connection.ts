import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type RowDataPacket,
} from "mysql2/promise";
// The pool's 'connection' event hands us the underlying callback-style
// Connection (not the promise-wrapped one), so we import its type from the
// non-promise entry point.
import type { Connection as CallbackConnection } from "mysql2";
import { type DoltConfig } from "../config.js";
import { logger } from "../logging/logger.js";

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
  // Dolt runs with --no-auto-commit, so new connections start at
  // autocommit=0 and each holds a frozen REPEATABLE READ snapshot — cross-
  // connection writes are invisible until the snapshot is reset. Force
  // autocommit=1 here so each statement is its own transaction.
  // The cast: mysql2/promise's Pool type only declares the 'enqueue' event,
  // but the underlying callback pool also emits 'connection'. The conn it
  // hands us is the callback-style Connection (not the promise wrapper).
  const onConn = pool.on.bind(pool) as unknown as (
    event: "connection",
    cb: (conn: CallbackConnection) => void,
  ) => Pool;
  onConn("connection", (conn) => {
    conn.query("SET SESSION autocommit = 1", (err: Error | null) => {
      if (err) {
        // Destroy the connection so it never enters the pool with autocommit=0
        // — a poisoned connection would silently reintroduce the cross-conn
        // visibility bug. mysql2 will create a fresh one on next acquire.
        logger.error("failed to SET autocommit=1 on new connection", {
          component: "db",
          error: err.message,
        });
        conn.destroy();
      }
    });
  });
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
 * The finally block restores the connection to a known clean state — back
 * on the default branch and with autocommit=1 — before returning it to
 * the pool, preventing branch-corruption and silent-rollback bugs when
 * the callback uses doltCheckout/doltMerge or toggles autocommit for a
 * grouped DOLT_COMMIT. Use this instead of withConnection when the
 * callback may switch branches or run multi-statement Dolt commits.
 */
export async function withBranchConnection<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    return await fn(conn);
  } finally {
    // Centralized invariant: every connection released by this helper is
    // returned to the pool with autocommit=1. Callers that drop autocommit
    // for a grouped Dolt commit (e.g. writeContext) no longer have to
    // remember to restore it themselves, and a future caller that forgets
    // can't silently leak autocommit=0 to the next pool consumer.
    try {
      await conn.query("SET @@autocommit = 1");
    } catch {
      // Connection may be broken; release it anyway.
    }
    try {
      await conn.query("CALL DOLT_CHECKOUT(?)", [DEFAULT_BRANCH]);
    } catch {
      // Already on default or connection broken.
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
