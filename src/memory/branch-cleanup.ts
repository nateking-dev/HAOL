import { getPool } from "../db/connection.js";
import { doltDeleteBranch } from "../db/dolt.js";
import { logger } from "../logging/logger.js";
import type { RowDataPacket } from "mysql2/promise";

interface BranchRow extends RowDataPacket {
  name: string;
  latest_commit_date: string;
}

interface TaskStatusRow extends RowDataPacket {
  task_id: string;
  status: string;
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);
const SESSION_BRANCH_PREFIX = "session/";

export async function pruneSessionBranches(retentionDays: number): Promise<string[]> {
  const pool = getPool();

  const [rows] = await pool.query<BranchRow[]>(
    `SELECT name, latest_commit_date FROM dolt_branches WHERE name LIKE 'session/%'`,
  );

  const cutoff =
    retentionDays > 0 ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000) : null;
  const candidates = rows.filter(
    (row) => cutoff === null || new Date(row.latest_commit_date) <= cutoff,
  );

  // Active-task guard: a session/{taskId} branch must not be deleted while
  // the task is still in flight, or the next memory step surfaces a cryptic
  // Dolt "branch not found" error. One batched lookup keeps this cheap even
  // when the candidate list grows large.
  const taskIds = candidates.map((c) => c.name.slice(SESSION_BRANCH_PREFIX.length));
  const activeIds = taskIds.length > 0 ? await findActiveTaskIds(taskIds) : new Set<string>();

  const pruned: string[] = [];
  for (const row of candidates) {
    const taskId = row.name.slice(SESSION_BRANCH_PREFIX.length);
    if (activeIds.has(taskId)) {
      logger.debug("skipped active session branch", {
        component: "memory",
        branch: row.name,
        task_id: taskId,
      });
      continue;
    }
    try {
      await doltDeleteBranch(row.name);
      pruned.push(row.name);
    } catch (err) {
      logger.warn("failed to delete session branch", {
        component: "memory",
        branch: row.name,
        error: (err as Error).message,
      });
    }
  }

  return pruned;
}

async function findActiveTaskIds(taskIds: string[]): Promise<Set<string>> {
  const pool = getPool();
  const placeholders = taskIds.map(() => "?").join(", ");
  // Rows with no task_log entry (orphans) and rows in terminal states are
  // both safe to prune; only non-terminal rows protect a branch.
  const [rows] = await pool.query<TaskStatusRow[]>(
    `SELECT task_id, status FROM task_log WHERE task_id IN (${placeholders})`,
    taskIds,
  );
  const active = new Set<string>();
  for (const row of rows) {
    if (!TERMINAL_STATUSES.has(row.status)) {
      active.add(row.task_id);
    }
  }
  return active;
}
