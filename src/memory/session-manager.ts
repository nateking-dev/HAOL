import { getPool, withBranchConnection, DEFAULT_BRANCH, type Queryable } from "../db/connection.js";
import {
  doltBranch,
  doltCheckout,
  doltCommit,
  doltMerge,
  doltDeleteBranch,
  doltActiveBranch,
} from "../db/dolt.js";
import * as sessionRepo from "../repositories/session-context.js";
import * as handoffRepo from "../repositories/handoff-summary.js";

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
    await conn.query("SET @@autocommit = 1");
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
    await conn.query("SET @@autocommit = 1");
    await doltCheckout(session.branch, conn);
    try {
      // Drop to autocommit=0 so the upsert stays in the working set and
      // our explicit DOLT_COMMIT below captures it as a single Dolt commit
      // with a descriptive message — instead of the per-statement implicit
      // commit producing an anonymous one.
      await conn.query("SET @@autocommit = 0");
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
      await conn.query("SET @@autocommit = 1");
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
    await conn.query("SET @@autocommit = 1");
    await ensureOnMain(conn);
    // Pool connections under --no-auto-commit can carry an uncommitted
    // working set on main from earlier writeContext callers (whose branch
    // checkout leaks staged changes back onto main). DOLT_MERGE refuses to
    // run with "local changes would be stomped by merge", so flush whatever
    // is pending into a Dolt commit before merging. Gate on dolt_status so
    // the common (clean working set) case doesn't add a noisy "pre-merge
    // flush" entry to main's log on every successful task.
    const [statusRows] = await conn.query("SELECT 1 FROM dolt_status LIMIT 1");
    if ((statusRows as unknown[]).length > 0) {
      await doltCommit(
        {
          message: `session:${session.taskId} | pre-merge flush`,
          author: "haol-memory <haol@system>",
        },
        conn,
      );
    }
    const mergeResult = await doltMerge(session.branch, conn);
    if (mergeResult.conflicts > 0) {
      // Resolve with --ours strategy by committing as-is
      await doltCommit(
        {
          message: `session:${session.taskId} | merge (conflicts resolved with --ours)`,
          author: "haol-memory <haol@system>",
          allowEmpty: true,
        },
        conn,
      );
    }
    await doltDeleteBranch(session.branch, conn);
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
