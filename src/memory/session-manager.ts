import { getPool, withConnection, DEFAULT_BRANCH, type Queryable } from "../db/connection.js";
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
  await withConnection(async (conn) => {
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
  await withConnection(async (conn) => {
    await doltCheckout(session.branch, conn);
    try {
      // Disable autocommit so the upsert stays in the working set
      // until our explicit DOLT_COMMIT captures it with a message.
      await conn.query("SET @@autocommit = 0");
      await sessionRepo.upsert(session.taskId, key, value, conn);
      await doltCommit(
        {
          message: `session:${session.taskId} | write context key=${key}`,
          author: "haol-memory <haol@system>",
        },
        conn,
      );
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
  await withConnection(async (conn) => {
    await ensureOnMain(conn);
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
    // Clean up the branch
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
