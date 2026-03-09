import { query, getPool } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";

export interface HandoffSummaryRecord {
  task_id: string;
  from_agent_id: string;
  summary: string;
  created_at: string;
}

interface HandoffSummaryRow extends RowDataPacket {
  task_id: string;
  from_agent_id: string;
  summary: string;
  created_at: string;
}

function parseRow(row: HandoffSummaryRow): HandoffSummaryRecord {
  return {
    task_id: row.task_id,
    from_agent_id: row.from_agent_id,
    summary: row.summary,
    created_at: row.created_at,
  };
}

export async function insert(taskId: string, fromAgentId: string, summary: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO handoff_summary (task_id, from_agent_id, summary)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE summary = VALUES(summary)`,
    [taskId, fromAgentId, summary],
  );
}

export async function findByTaskId(taskId: string): Promise<HandoffSummaryRecord[]> {
  const rows = await query<HandoffSummaryRow[]>(
    "SELECT * FROM handoff_summary WHERE task_id = ? ORDER BY created_at DESC",
    [taskId],
  );
  return rows.map(parseRow);
}

export async function findLatest(taskId: string): Promise<HandoffSummaryRecord | null> {
  const rows = await query<HandoffSummaryRow[]>(
    "SELECT * FROM handoff_summary WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
    [taskId],
  );
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}
