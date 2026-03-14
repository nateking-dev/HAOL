import { getPool } from "../db/connection.js";
import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { TaskOutcomeRecord } from "../types/outcome.js";

interface TaskOutcomeRow extends RowDataPacket {
  outcome_id: string;
  task_id: string;
  tier: number;
  source: string;
  signal_type: string;
  signal_value: number | null;
  confidence: number | null;
  detail: string | Record<string, unknown> | null;
  reported_by: string | null;
  created_at: string;
}

function parseRow(row: TaskOutcomeRow): TaskOutcomeRecord {
  let detail: Record<string, unknown> | null = null;
  if (row.detail) {
    if (typeof row.detail === "string") {
      try {
        detail = JSON.parse(row.detail);
      } catch {
        detail = null;
      }
    } else {
      detail = row.detail;
    }
  }

  return {
    outcome_id: row.outcome_id,
    task_id: row.task_id,
    tier: row.tier as 0 | 1 | 2 | 3,
    source: row.source as "pipeline" | "format_check" | "routing_eval" | "downstream",
    signal_type: row.signal_type,
    signal_value: row.signal_value != null ? (row.signal_value as 0 | 1) : null,
    confidence: row.confidence,
    detail,
    reported_by: row.reported_by,
    created_at: row.created_at,
  };
}

export async function insert(record: TaskOutcomeRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.outcome_id,
      record.task_id,
      record.tier,
      record.source,
      record.signal_type,
      record.signal_value,
      record.confidence,
      record.detail ? JSON.stringify(record.detail) : null,
      record.reported_by,
    ],
  );
}

export async function insertBatch(records: TaskOutcomeRecord[]): Promise<void> {
  if (records.length === 0) return;
  const pool = getPool();
  const values = records.map((r) => [
    r.outcome_id,
    r.task_id,
    r.tier,
    r.source,
    r.signal_type,
    r.signal_value,
    r.confidence,
    r.detail ? JSON.stringify(r.detail) : null,
    r.reported_by,
  ]);
  const placeholders = records.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  await pool.query(
    `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by)
     VALUES ${placeholders}`,
    values.flat(),
  );
}

export async function findByTaskId(taskId: string): Promise<TaskOutcomeRecord[]> {
  const rows = await query<TaskOutcomeRow[]>(
    "SELECT * FROM task_outcome WHERE task_id = ? ORDER BY created_at, outcome_id",
    [taskId],
  );
  return rows.map(parseRow);
}

export async function findByTaskIdAndTier(
  taskId: string,
  tier: number,
): Promise<TaskOutcomeRecord[]> {
  const rows = await query<TaskOutcomeRow[]>(
    "SELECT * FROM task_outcome WHERE task_id = ? AND tier = ? ORDER BY created_at, outcome_id",
    [taskId, tier],
  );
  return rows.map(parseRow);
}

/**
 * Returns tasks that have no Tier 2 outcome records yet,
 * with routing_confidence below the given threshold, ordered ascending.
 */
export async function findTasksWithoutTier2Eval(
  threshold: number,
  hours: number,
  limit: number,
): Promise<Array<{ task_id: string; routing_confidence: number }>> {
  const rows = await query<(RowDataPacket & { task_id: string; routing_confidence: number })[]>(
    `SELECT t.task_id, t.routing_confidence
     FROM task_log t
     LEFT JOIN task_outcome o ON o.task_id = t.task_id AND o.tier = 2
     WHERE t.routing_confidence IS NOT NULL
       AND t.routing_confidence < ?
       AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND o.outcome_id IS NULL
     ORDER BY t.routing_confidence ASC
     LIMIT ?`,
    [threshold, hours, limit],
  );
  return rows.map((r) => ({
    task_id: r.task_id,
    routing_confidence: r.routing_confidence,
  }));
}

/**
 * Deletes evaluation_pending records older than maxAgeHours that have
 * no matching evaluation_complete or evaluation_failed record.
 * Returns the number of rows deleted.
 */
export async function cleanupOrphanedPendingRecords(maxAgeHours: number): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query(
    `DELETE FROM task_outcome
     WHERE signal_type = 'evaluation_pending'
       AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND task_id NOT IN (
         SELECT t2.task_id FROM (
           SELECT DISTINCT task_id FROM task_outcome
           WHERE signal_type IN ('evaluation_complete', 'evaluation_failed')
         ) AS t2
       )`,
    [maxAgeHours],
  );
  return (result as any).affectedRows ?? 0;
}

/**
 * Counts evaluation_pending records older than staleThresholdHours
 * with no matching completion/failure record.
 */
export async function countOrphanedPendingRecords(staleThresholdHours: number): Promise<number> {
  const rows = await query<(RowDataPacket & { count: string | number })[]>(
    `SELECT COUNT(*) AS count
     FROM task_outcome p
     WHERE p.signal_type = 'evaluation_pending'
       AND p.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND NOT EXISTS (
         SELECT 1 FROM task_outcome t2
         WHERE t2.task_id = p.task_id
           AND t2.signal_type IN ('evaluation_complete', 'evaluation_failed')
       )`,
    [staleThresholdHours],
  );
  const raw = rows[0]?.count ?? 0;
  return typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
}

export interface AgentOutcomeScore {
  agent_id: string;
  positive: number;
  total: number;
}

/**
 * Returns positive/total outcome signal counts per agent for scoring.
 * Includes tiers 1, 2, 3 with non-null signal_value only.
 */
export async function getAgentOutcomeScores(hours: number): Promise<AgentOutcomeScore[]> {
  const rows = await query<
    (RowDataPacket & { agent_id: string; positive: number; total: number })[]
  >(
    `SELECT t.selected_agent_id AS agent_id,
            SUM(CASE WHEN o.signal_value = 1 THEN 1 ELSE 0 END) AS positive,
            COUNT(*) AS total
     FROM task_outcome o
     JOIN task_log t ON t.task_id = o.task_id
     WHERE o.tier IN (1, 2, 3)
       AND o.signal_value IS NOT NULL
       AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND t.selected_agent_id IS NOT NULL
     GROUP BY t.selected_agent_id`,
    [hours],
  );
  return rows.map((r) => ({
    agent_id: r.agent_id,
    positive: typeof r.positive === "string" ? parseInt(r.positive, 10) : Number(r.positive),
    total: typeof r.total === "string" ? parseInt(r.total, 10) : Number(r.total),
  }));
}
