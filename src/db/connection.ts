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
  // Dolt's SQL server runs with --no-auto-commit, so every new connection
  // arrives with autocommit=0. Under autocommit=0 each connection holds an
  // implicit transaction with REPEATABLE READ semantics — a SELECT on
  // connection B started before connection A's COMMIT will never see A's
  // writes, even after A commits. That breaks every cross-connection
  // workflow (HTTP handler INSERT → worker SELECT, reaper UPDATE → worker
  // SELECT, etc.) which is why test runs that span pool connections look
  // intermittently broken.
  //
  // Force autocommit=1 on every new physical connection so each statement
  // is its own transaction and reads always see the latest committed
  // state. Code paths that need grouped Dolt commits (writeContext,
  // commitSession) explicitly toggle autocommit themselves and reset it
  // to 1 in their finally block via withBranchConnection's cleanup.
  // mysql2's 'connection' event hands us the underlying callback-style
  // Connection (not the promise-wrapped one), so we use the cb form here.
  // The promise interface would throw "tried to call .then() on a non-
  // promise" — exactly what surfaced when this was first written with
  // .catch(). The callback form is documented in mysql2's pool example
  // at https://sidorares.github.io/node-mysql2/docs#using-connection-pools.
  pool.on("connection", (conn) => {
    (conn as unknown as { query(sql: string, cb: (err: Error | null) => void): void }).query(
      "SET SESSION autocommit = 1",
      (err) => {
        if (err) {
          // Logging is the best we can do — throwing from an event handler
          // crashes the process. Subsequent uses of this connection will
          // resurface the underlying issue.
          // eslint-disable-next-line no-console
          console.error("[db] failed to SET autocommit=1 on new connection:", err.message);
        }
      },
    );
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
