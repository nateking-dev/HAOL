import { execute, getPool } from "../../db/connection.js";
import { logger } from "../../logging/logger.js";
import type { RowDataPacket } from "mysql2/promise";
import type { TuneResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tuning-run lifecycle: advisory lock + tuning_run record state
// ---------------------------------------------------------------------------

const LOCK_NAME = "haol_tuner";

/**
 * Acquires the advisory lock that serializes tuning runs, clears any stale
 * 'running' records left by crashed processes, and inserts a fresh
 * 'running' tuning_run row.
 *
 * GET_LOCK is truly atomic — the DB serializes callers. Throws if another
 * run currently holds the lock.
 */
export async function acquireTunerLock(runId: string, hours: number): Promise<void> {
  const pool = getPool();

  // GET_LOCK returns 1 if acquired, 0 if timed out. Timeout of 0
  // means fail immediately if another session holds the lock.
  const [lockRows] = await pool.query<RowDataPacket[]>(
    `SELECT GET_LOCK('${LOCK_NAME}', 0) AS acquired`,
  );
  const acquired = (lockRows as Record<string, unknown>[])[0]?.acquired;
  if (acquired !== 1) {
    throw new Error("Another tuning run is already in progress");
  }

  // Also check for stale 'running' records from crashed processes
  const [staleRows] = await pool.query<RowDataPacket[]>(
    `SELECT run_id FROM tuning_run
     WHERE status = 'running'
       AND started_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
  );
  for (const row of staleRows as Record<string, unknown>[]) {
    await pool.query(
      `UPDATE tuning_run SET status = 'failed', completed_at = NOW(),
              error_message = 'Marked stale by subsequent run'
       WHERE run_id = ?`,
      [row.run_id],
    );
  }

  await execute(`INSERT INTO tuning_run (run_id, status, hours_window) VALUES (?, 'running', ?)`, [
    runId,
    hours,
  ]);
}

/** Releases the advisory lock. Best-effort — it auto-releases on disconnect. */
export async function releaseTunerLock(): Promise<void> {
  try {
    await execute(`SELECT RELEASE_LOCK('${LOCK_NAME}')`);
  } catch {
    // Lock release is best-effort — it auto-releases on disconnect
  }
}

/** Marks a tuning_run row as failed. Swallows its own errors (best-effort). */
export async function recordTunerFailure(runId: string, message: string): Promise<void> {
  try {
    await execute(
      `UPDATE tuning_run SET status = 'failed', completed_at = NOW(), error_message = ? WHERE run_id = ?`,
      [message, runId],
    );
  } catch (updateErr) {
    logger.error("failed to mark tuning_run as failed", {
      component: "routing-tuner",
      error: (updateErr as Error).message,
    });
  }
}

/** Writes the terminal tuning_run record from a completed (non-dry-run) result. */
export async function finalizeTuningRun(result: TuneResult): Promise<void> {
  await execute(
    `UPDATE tuning_run
     SET status = ?, completed_at = NOW(),
         tasks_analyzed = ?, signals_used = ?,
         rules_created = ?, utterances_added = ?,
         actionable_agent_tier_combos = ?,
         summary = ?
     WHERE run_id = ?`,
    [
      result.status,
      result.tasks_analyzed,
      result.signals_used,
      result.rules_created.length,
      result.utterances_added.length,
      result.actionable_agent_tier_combos,
      JSON.stringify({
        agent_tier_outcomes: result.agent_tier_outcomes,
        rules_created: result.rules_created.map((r) => ({
          pattern: r.pattern,
          tier: r.tier_id,
          task_count: r.source_task_count,
        })),
        utterances_added: result.utterances_added.length,
      }),
      result.run_id,
    ],
  );
}
