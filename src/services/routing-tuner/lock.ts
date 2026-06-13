import { execute, getPool } from "../../db/connection.js";
import { logger } from "../../logging/logger.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
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
 * MySQL's GET_LOCK is **session-scoped**: the lock is owned by the single
 * connection that acquired it, only that connection can release it, and it
 * stays held only while that connection is alive. Issuing RELEASE_LOCK on a
 * different pooled connection is a silent no-op that orphans the lock (#105).
 *
 * So the lock is bound to one dedicated connection, checked out from the pool
 * for the whole run. This function returns that held connection; the caller
 * MUST pass it to releaseTunerLock, which runs RELEASE_LOCK on it and returns
 * it to the pool. Throws (after releasing the connection) if another run holds
 * the lock.
 */
export async function acquireTunerLock(runId: string, hours: number): Promise<PoolConnection> {
  const conn = await getPool().getConnection();

  try {
    // GET_LOCK returns 1 if acquired, 0 if timed out. Timeout of 0
    // means fail immediately if another session holds the lock.
    const [lockRows] = await conn.query<RowDataPacket[]>(`SELECT GET_LOCK(?, 0) AS acquired`, [
      LOCK_NAME,
    ]);
    const acquired = (lockRows as Record<string, unknown>[])[0]?.acquired;
    if (acquired !== 1) {
      throw new Error("Another tuning run is already in progress");
    }
  } catch (err) {
    // GET_LOCK failed or the lock was unavailable — nothing is held, so just
    // hand the connection back to the pool.
    conn.release();
    throw err;
  }

  // The lock is held on `conn` now. All setup below runs on the same
  // connection so it stays alive (and thus the lock stays held). If anything
  // throws, release the lock on this connection before propagating —
  // otherwise the lock is orphaned and every subsequent run bails with
  // "already in progress".
  try {
    // Also check for stale 'running' records from crashed processes
    const [staleRows] = await conn.query<RowDataPacket[]>(
      `SELECT run_id FROM tuning_run
       WHERE status = 'running'
         AND started_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    );
    for (const row of staleRows as Record<string, unknown>[]) {
      await conn.query(
        `UPDATE tuning_run SET status = 'failed', completed_at = NOW(),
                error_message = 'Marked stale by subsequent run'
         WHERE run_id = ?`,
        [row.run_id],
      );
    }

    await conn.query(
      `INSERT INTO tuning_run (run_id, status, hours_window) VALUES (?, 'running', ?)`,
      [runId, hours],
    );
  } catch (err) {
    await releaseTunerLock(conn);
    throw err;
  }

  return conn;
}

/**
 * Releases the advisory lock on the connection that acquired it and returns
 * that connection to the pool. Best-effort on the RELEASE_LOCK itself (the
 * lock also auto-releases when the connection closes), but the connection is
 * always released back to the pool.
 */
export async function releaseTunerLock(conn: PoolConnection): Promise<void> {
  try {
    await conn.query(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]);
  } catch {
    // Lock release is best-effort — it auto-releases on disconnect
  } finally {
    conn.release();
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
