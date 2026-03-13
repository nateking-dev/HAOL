import { query, getPool } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { ExecutionRecord } from "../types/execution.js";

interface ExecutionRow extends RowDataPacket {
  execution_id: string;
  task_id: string;
  agent_id: string;
  attempt_number: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | number;
  latency_ms: number;
  ttft_ms: number;
  outcome: string;
  error_detail: string | null;
  created_at: string;
}

function parseRow(row: ExecutionRow): ExecutionRecord {
  return {
    execution_id: row.execution_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    attempt_number: row.attempt_number,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: typeof row.cost_usd === "string" ? parseFloat(row.cost_usd) : row.cost_usd,
    latency_ms: row.latency_ms,
    ttft_ms: row.ttft_ms,
    outcome: row.outcome as ExecutionRecord["outcome"],
    error_detail: row.error_detail,
    response_content: null,
  };
}

export async function insertExecution(record: ExecutionRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO execution_log
       (execution_id, task_id, agent_id, attempt_number, input_tokens, output_tokens, cost_usd, latency_ms, ttft_ms, outcome, error_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.execution_id,
      record.task_id,
      record.agent_id,
      record.attempt_number,
      record.input_tokens,
      record.output_tokens,
      record.cost_usd,
      record.latency_ms,
      record.ttft_ms,
      record.outcome,
      record.error_detail,
    ],
  );
}

export async function findByTaskId(taskId: string): Promise<ExecutionRecord[]> {
  const rows = await query<ExecutionRow[]>(
    "SELECT * FROM execution_log WHERE task_id = ? ORDER BY attempt_number",
    [taskId],
  );
  return rows.map(parseRow);
}
