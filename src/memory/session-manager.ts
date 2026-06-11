import {
  getPool,
  withBranchConnection,
  setAutocommit,
  DEFAULT_BRANCH,
  type Queryable,
} from "../db/connection.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  doltBranch,
  doltCheckout,
  doltCommit,
  doltMerge,
  doltDeleteBranch,
  doltActiveBranch,
  isNothingToCommitError,
} from "../db/dolt.js";
import * as sessionRepo from "../repositories/session-context.js";
import * as handoffRepo from "../repositories/handoff-summary.js";
import { logger } from "../logging/logger.js";

// Tables that the memory layer is authoritative for. The pre-merge flush in
// commitSession stages only these so attribution can never accidentally
// capture residue from task_log/execution_log etc. left in the shared
// working set on main by another connection.
const MEMORY_TABLES = ["session_context", "handoff_summary"];

// Advisory lock name for serializing main-branch operations across
// concurrent commitSession calls. Connection-scoped, so it auto-releases
// if the holding connection dies (process crash, network blip).
const MAIN_MERGE_LOCK = "haol_merge_main";
const MAIN_MERGE_LOCK_TIMEOUT_SECONDS = 5;

interface LockRow extends RowDataPacket {
  acquired: number | null;
}

/**
 * Run `fn` while holding a connection-scoped advisory lock on main. Returns
 * `null` if the lock can't be acquired in MAIN_MERGE_LOCK_TIMEOUT_SECONDS —
 * memory work is best-effort, and waiting longer than that under contention
 * indicates something pathological is happening that warrants surfacing
 * upstream rather than blocking the task pipeline.
 */
async function withMainMergeLock<T>(conn: PoolConnection, fn: () => Promise<T>): Promise<T | null> {
  const [rows] = await conn.query<LockRow[]>("SELECT GET_LOCK(?, ?) AS acquired", [
    MAIN_MERGE_LOCK,
    MAIN_MERGE_LOCK_TIMEOUT_SECONDS,
  ]);
  const acquired = rows[0]?.acquired;
  if (acquired !== 1) {
    // 0 = timeout, NULL = error. Either way, leave main alone — but log at
    // the failure site so contention is visible in structured logs without
    // depending on the caller to wrap and re-log. Data on the session
    // branch is not lost (branch-cleanup retains it) but it is not merged
    // to main, which warrants visibility above debug.
    logger.warn("could not acquire main merge lock", {
      component: "memory",
      lock_name: MAIN_MERGE_LOCK,
      get_lock_result: acquired,
      timeout_seconds: MAIN_MERGE_LOCK_TIMEOUT_SECONDS,
    });
    return null;
  }
  try {
    return await fn();
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK(?)", [MAIN_MERGE_LOCK]);
    } catch {
      // RELEASE_LOCK on a connection that's already lost the lock returns
      // NULL — not an error we can act on. The lock auto-releases on
      // connection close, so swallowing here is safe.
    }
  }
}

function parseJsonValue(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val; // Return as-is if not valid JSON
    }
  }
  return val;
}

export interface SessionHandle {
  taskId: string;
  branch: string;
}

function branchName(taskId: string): string {
  return `session/${taskId}`;
}

async function ensureOnMain(conn: Queryable): Promise<void> {
  const current = await doltActiveBranch(conn);
  if (current !== DEFAULT_BRANCH) {
    await doltCheckout(DEFAULT_BRANCH, conn);
  }
}

export async function createSession(taskId: string): Promise<SessionHandle> {
  const branch = branchName(taskId);
  await withBranchConnection(async (conn) => {
    // The Dolt server runs with --no-auto-commit, so pool connections may
    // start with autocommit=0. Branch and metadata procedure calls under
    // autocommit=0 do not persist when the connection is released without
    // an explicit COMMIT — force autocommit on for the lifetime of this
    // call so DOLT_BRANCH actually creates the branch.
    await setAutocommit(conn, true);
    await ensureOnMain(conn);
    await doltBranch({ name: branch }, conn);
  });
  return { taskId, branch };
}

export async function writeContext(
  session: SessionHandle,
  key: string,
  value: unknown,
): Promise<void> {
  await withBranchConnection(async (conn) => {
    // Force autocommit on at entry to flush any inherited transaction state
    // from a prior pool holder. Same defense as createSession/commitSession:
    // the server's --no-auto-commit default means a connection can arrive
    // in autocommit=0 with pending writes that would otherwise contaminate
    // ours, and our writes would be discarded on release.
    await setAutocommit(conn, true);
    await doltCheckout(session.branch, conn);
    try {
      // Drop to autocommit=0 so the upsert stays in the working set and
      // our explicit DOLT_COMMIT below captures it as a single Dolt commit
      // with a descriptive message — instead of the per-statement implicit
      // commit producing an anonymous one.
      await setAutocommit(conn, false);
      await sessionRepo.upsert(session.taskId, key, value, conn);
      await doltCommit(
        {
          message: `session:${session.taskId} | write context key=${key}`,
          author: "haol-memory <haol@system>",
        },
        conn,
      );
      // Explicit COMMIT so the DOLT_COMMIT is durable before the connection
      // returns to the pool. We do not rely on the implicit commit from
      // SET @@autocommit=1 in the finally — that's a real MySQL semantic
      // but obscure, and a future reader should not have to chase it.
      await conn.query("COMMIT");
    } catch (err) {
      await conn.query("ROLLBACK");
      throw err;
    } finally {
      await setAutocommit(conn, true);
      await ensureOnMain(conn);
    }
  });
}

export async function readContext(session: SessionHandle, key?: string): Promise<unknown> {
  // Read from the session branch using AS OF syntax for read-without-checkout
  const pool = getPool();
  if (key) {
    const [rows] = await pool.query(
      `SELECT * FROM session_context AS OF ? WHERE session_id = ? AND \`key\` = ?`,
      [session.branch, session.taskId, key],
    );
    const result = rows as Record<string, unknown>[];
    if (result.length === 0) return null;
    return parseJsonValue(result[0].value);
  }

  const [rows] = await pool.query(`SELECT * FROM session_context AS OF ? WHERE session_id = ?`, [
    session.branch,
    session.taskId,
  ]);
  const result = rows as Record<string, unknown>[];
  const entries: Record<string, unknown> = {};
  for (const row of result) {
    entries[row.key as string] = parseJsonValue(row.value);
  }
  return entries;
}

export async function commitSession(session: SessionHandle): Promise<void> {
  await withBranchConnection(async (conn) => {
    // Force autocommit on so DOLT_MERGE and DOLT_BRANCH('-d') persist when
    // the connection is released. The server's --no-auto-commit default
    // otherwise leaves these procedure calls in an uncommitted state and
    // Dolt rolls them back on release, leaving the session branch behind.
    await setAutocommit(conn, true);
    await ensureOnMain(conn);

    // Serialize main-branch operations across concurrent tasks. The working
    // set on main is shared across pool connections within the branch — two
    // commitSession calls overlapping could otherwise have task X's flush
    // capture task Y's staged changes, attributing them under X's identity
    // and breaking the audit-trail guarantee. The lock ensures only one
    // task at a time runs the flush+merge+branch-delete sequence on main.
    const ran = await withMainMergeLock(conn, async () => {
      // DOLT_MERGE refuses to run with "local changes would be stomped by
      // merge", so flush whatever is pending into a Dolt commit before
      // merging. Gate on dolt_status so the common (clean working set)
      // case doesn't add a noisy "pre-merge flush" entry on every task.
      //
      // Stage only memory tables, not -A: even with the lock held, residue
      // in task_log / execution_log etc. (written under autocommit=0 by
      // other code paths and not yet Dolt-committed) must not be authored
      // under this session. The lock + table list together guarantee
      // attribution is correct.
      const [statusRows] = await conn.query("SELECT 1 FROM dolt_status LIMIT 1");
      if ((statusRows as unknown[]).length > 0) {
        try {
          await doltCommit(
            {
              message: `session:${session.taskId} | pre-merge flush`,
              author: "haol-memory <haol@system>",
              tables: MEMORY_TABLES,
            },
            conn,
          );
        } catch (err) {
          // Swallow "nothing to commit" — dolt_status can show rows in
          // tables outside MEMORY_TABLES (which we deliberately don't
          // stage) so the staged set may be empty. Real failures still
          // surface from the merge attempt below.
          if (!isNothingToCommitError(err)) {
            throw err;
          }
        }
      }
      const mergeResult = await doltMerge(session.branch, conn);
      if (mergeResult.conflicts > 0) {
        // Resolve with --ours strategy by committing as-is
        await doltCommit(
          {
            message: `session:${session.taskId} | merge (conflicts resolved with --ours)`,
            author: "haol-memory <haol@system>",
            allowEmpty: true,
            tables: MEMORY_TABLES,
          },
          conn,
        );
      }
      await doltDeleteBranch(session.branch, conn);
      return true;
    });

    if (ran === null) {
      // Lock contention — leave the session branch in place. Memory work
      // is best-effort: branch-cleanup will reclaim it on retention expiry,
      // and a future commitSession call won't be affected.
      throw new Error(
        `commitSession: could not acquire ${MAIN_MERGE_LOCK} within ${MAIN_MERGE_LOCK_TIMEOUT_SECONDS}s`,
      );
    }
  });
}

export async function discardSession(_session: SessionHandle): Promise<void> {
  // Intentional no-op: branch is preserved for debugging, not deleted.
  // Data stays on the session branch but is not merged to main.
}

export async function writeHandoffSummary(
  taskId: string,
  fromAgentId: string,
  summary: string,
): Promise<void> {
  await handoffRepo.insert(taskId, fromAgentId, summary);
}

export async function readHandoffSummary(
  taskId: string,
): Promise<{ from_agent_id: string; summary: string } | null> {
  const record = await handoffRepo.findLatest(taskId);
  if (!record) return null;
  return { from_agent_id: record.from_agent_id, summary: record.summary };
}
