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
    detail =
      typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
  }

  return {
    outcome_id: row.outcome_id,
    task_id: row.task_id,
    tier: row.tier as 0 | 1 | 2 | 3,
    source: row.source as
      | "pipeline"
      | "format_check"
      | "routing_eval"
      | "downstream",
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
  const placeholders = records
    .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .join(", ");
  await pool.query(
    `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by)
     VALUES ${placeholders}`,
    values.flat(),
  );
}

export async function findByTaskId(
  taskId: string,
): Promise<TaskOutcomeRecord[]> {
  const rows = await query<TaskOutcomeRow[]>(
    "SELECT * FROM task_outcome WHERE task_id = ? ORDER BY created_at",
    [taskId],
  );
  return rows.map(parseRow);
}

export async function findByTaskIdAndTier(
  taskId: string,
  tier: number,
): Promise<TaskOutcomeRecord[]> {
  const rows = await query<TaskOutcomeRow[]>(
    "SELECT * FROM task_outcome WHERE task_id = ? AND tier = ? ORDER BY created_at",
    [taskId, tier],
  );
  return rows.map(parseRow);
}

export async function findLowConfidenceTasks(
  threshold: number,
  hours: number,
  limit: number,
): Promise<Array<{ task_id: string; routing_confidence: number }>> {
  const rows = await query<
    (RowDataPacket & { task_id: string; routing_confidence: number })[]
  >(
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
