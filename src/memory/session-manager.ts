import { getPool } from "../db/connection.js";
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

async function ensureOnMain(): Promise<void> {
  const current = await doltActiveBranch();
  if (current !== "main") {
    await doltCheckout("main");
  }
}

export async function createSession(taskId: string): Promise<SessionHandle> {
  await ensureOnMain();
  const branch = branchName(taskId);
  await doltBranch({ name: branch });
  return { taskId, branch };
}

export async function writeContext(
  session: SessionHandle,
  key: string,
  value: unknown,
): Promise<void> {
  await doltCheckout(session.branch);
  try {
    await sessionRepo.upsert(session.taskId, key, value);
    await doltCommit({
      message: `session:${session.taskId} | write context key=${key}`,
      author: "haol-memory <haol@system>",
    });
  } finally {
    await ensureOnMain();
  }
}

export async function readContext(
  session: SessionHandle,
  key?: string,
): Promise<unknown> {
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

  const [rows] = await pool.query(
    `SELECT * FROM session_context AS OF ? WHERE session_id = ?`,
    [session.branch, session.taskId],
  );
  const result = rows as Record<string, unknown>[];
  const entries: Record<string, unknown> = {};
  for (const row of result) {
    entries[row.key as string] = parseJsonValue(row.value);
  }
  return entries;
}

export async function commitSession(session: SessionHandle): Promise<void> {
  await ensureOnMain();
  const mergeResult = await doltMerge(session.branch);
  if (mergeResult.conflicts > 0) {
    // Resolve with --ours strategy by committing as-is
    await doltCommit({
      message: `session:${session.taskId} | merge (conflicts resolved with --ours)`,
      author: "haol-memory <haol@system>",
      allowEmpty: true,
    });
  }
  // Clean up the branch
  await doltDeleteBranch(session.branch);
}

export async function discardSession(session: SessionHandle): Promise<void> {
  await ensureOnMain();
  // Branch is preserved for debugging, not deleted
  // Data stays on the session branch but is not merged to main
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
