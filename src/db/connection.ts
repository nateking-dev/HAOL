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

// Per-connection record of the state that withBranchConnection must restore on
// release: whether the connection currently sits off the default branch, and
// whether autocommit is disabled. Keyed by the PoolConnection object, which
// mysql2 reuses across acquire/release cycles, so the record persists for the
// connection's lifetime.
//
// A connection with no record is treated conservatively as dirty (both resets
// run) — that matches the original always-reset behavior for any connection we
// haven't observed. Once observed, the resets are skipped whenever the tracked
// state says the connection is already clean. Real callers create a record on
// entry (every withBranchConnection callback calls setAutocommit first), so
// they always get the fast path; the conservative default only covers
// connections mutated outside the tracked helpers.
//
// Contract: inside a withBranchConnection callback, branch switches MUST go
// through doltCheckout (which calls noteConnectionBranch) and autocommit
// changes through setAutocommit. A raw conn.query that bypasses these leaves
// the tracking stale and can skip a needed reset.
interface BranchConnState {
  offDefaultBranch: boolean;
  autocommitDisabled: boolean;
}
const branchConnState = new WeakMap<PoolConnection, BranchConnState>();

function isPoolConnection(conn: Queryable): conn is PoolConnection {
  return typeof (conn as PoolConnection).release === "function";
}

function stateFor(conn: PoolConnection): BranchConnState {
  let state = branchConnState.get(conn);
  if (!state) {
    state = { offDefaultBranch: false, autocommitDisabled: false };
    branchConnState.set(conn, state);
  }
  return state;
}

/**
 * Record that `conn` was checked out onto `branch`, so withBranchConnection can
 * skip a redundant DOLT_CHECKOUT on release when the connection is already on
 * the default branch. No-op for a Pool (tracking applies to single
 * connections only). Called by doltCheckout — callers don't invoke it directly.
 */
export function noteConnectionBranch(conn: Queryable, branch: string): void {
  if (!isPoolConnection(conn)) return;
  stateFor(conn).offDefaultBranch = branch !== DEFAULT_BRANCH;
}

/**
 * Set autocommit on `conn` and record the new state, so withBranchConnection
 * can skip a redundant `SET @@autocommit = 1` on release. Use this instead of a
 * raw `conn.query("SET @@autocommit = ...")` inside a branch-connection
 * callback, otherwise the tracking goes stale.
 */
export async function setAutocommit(conn: PoolConnection, enabled: boolean): Promise<void> {
  await conn.query(`SET @@autocommit = ${enabled ? 1 : 0}`);
  stateFor(conn).autocommitDisabled = !enabled;
}

/**
 * Which resets withBranchConnection must perform before releasing `conn`.
 * Untracked connections are conservatively reported as needing both.
 */
export function connectionNeedsReset(conn: PoolConnection): {
  autocommit: boolean;
  checkout: boolean;
} {
  const state = branchConnState.get(conn);
  if (!state) return { autocommit: true, checkout: true };
  return { autocommit: state.autocommitDisabled, checkout: state.offDefaultBranch };
}

function markConnectionClean(conn: PoolConnection): void {
  const state = stateFor(conn);
  state.offDefaultBranch = false;
  state.autocommitDisabled = false;
}

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
    // returned to the pool with autocommit=1 and on the default branch.
    // Callers that drop autocommit for a grouped Dolt commit (e.g.
    // writeContext) no longer have to remember to restore it themselves, and a
    // future caller that forgets can't silently leak autocommit=0 to the next
    // pool consumer.
    //
    // The resets are skipped when per-connection tracking shows the callback
    // already left the connection clean (the common case — every memory caller
    // restores autocommit=1 and checks out main before returning), avoiding two
    // round-trips per release. See connectionNeedsReset / the branchConnState
    // tracking above.
    const needs = connectionNeedsReset(conn);
    if (needs.autocommit) {
      try {
        await conn.query("SET @@autocommit = 1");
      } catch {
        // Connection may be broken; release it anyway.
      }
    }
    if (needs.checkout) {
      try {
        await conn.query("CALL DOLT_CHECKOUT(?)", [DEFAULT_BRANCH]);
      } catch {
        // Already on default or connection broken.
      }
    }
    // The connection is now (best-effort) on the default branch with
    // autocommit=1; record that so the next acquisition starts from accurate
    // state rather than the conservative untracked default.
    markConnectionClean(conn);
    conn.release();
  }
}

export async function destroy(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
