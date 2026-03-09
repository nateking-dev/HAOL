import { getPool } from "../db/connection.js";
import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { TaskStatus } from "../types/router.js";

interface TaskLogRow extends RowDataPacket {
  task_id: string;
  created_at: string;
  status: string;
  prompt_hash: string | null;
  complexity_tier: number | null;
  required_capabilities: string | string[] | null;
  cost_ceiling_usd: string | number | null;
  selected_agent_id: string | null;
  selection_rationale: string | Record<string, unknown> | null;
}

export interface TaskLogRecord {
  task_id: string;
  created_at: string;
  status: TaskStatus;
  prompt_hash: string | null;
  complexity_tier: number | null;
  required_capabilities: string[] | null;
  cost_ceiling_usd: number | null;
  selected_agent_id: string | null;
  selection_rationale: Record<string, unknown> | null;
}

function parseRow(row: TaskLogRow): TaskLogRecord {
  let capabilities: string[] | null = null;
  if (row.required_capabilities) {
    capabilities =
      typeof row.required_capabilities === "string"
        ? JSON.parse(row.required_capabilities)
        : row.required_capabilities;
  }

  let rationale: Record<string, unknown> | null = null;
  if (row.selection_rationale) {
    rationale =
      typeof row.selection_rationale === "string"
        ? JSON.parse(row.selection_rationale)
        : (row.selection_rationale as Record<string, unknown>);
  }

  return {
    task_id: row.task_id,
    created_at: row.created_at,
    status: row.status as TaskStatus,
    prompt_hash: row.prompt_hash,
    complexity_tier: row.complexity_tier,
    required_capabilities: capabilities,
    cost_ceiling_usd:
      row.cost_ceiling_usd != null
        ? typeof row.cost_ceiling_usd === "string"
          ? parseFloat(row.cost_ceiling_usd)
          : row.cost_ceiling_usd
        : null,
    selected_agent_id: row.selected_agent_id,
    selection_rationale: rationale,
  };
}

export async function create(taskId: string, promptHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'RECEIVED', ?)`,
    [taskId, promptHash],
  );
}

export async function updateClassification(
  taskId: string,
  tier: number,
  capabilities: string[],
  costCeiling: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
     SET status = 'CLASSIFIED',
         complexity_tier = ?,
         required_capabilities = ?,
         cost_ceiling_usd = ?
     WHERE task_id = ?`,
    [tier, JSON.stringify(capabilities), costCeiling, taskId],
  );
}

export async function updateSelection(
  taskId: string,
  agentId: string,
  rationale: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
     SET status = 'DISPATCHED',
         selected_agent_id = ?,
         selection_rationale = ?
     WHERE task_id = ?`,
    [agentId, JSON.stringify(rationale), taskId],
  );
}

export async function updateStatus(taskId: string, status: TaskStatus): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE task_log SET status = ? WHERE task_id = ?`, [status, taskId]);
}

export async function findById(taskId: string): Promise<TaskLogRecord | null> {
  const rows = await query<TaskLogRow[]>("SELECT * FROM task_log WHERE task_id = ?", [taskId]);
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}
