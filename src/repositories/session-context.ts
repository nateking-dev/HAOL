import { query, getPool } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";

export interface SessionContextRecord {
  session_id: string;
  key: string;
  value: unknown;
  updated_at: string;
}

interface SessionContextRow extends RowDataPacket {
  session_id: string;
  key: string;
  value: string | unknown;
  updated_at: string;
}

function parseRow(row: SessionContextRow): SessionContextRecord {
  return {
    session_id: row.session_id,
    key: row.key,
    value: typeof row.value === "string" ? JSON.parse(row.value) : row.value,
    updated_at: row.updated_at,
  };
}

export async function upsert(
  sessionId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO session_context (session_id, \`key\`, value)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [sessionId, key, JSON.stringify(value)],
  );
}

export async function findBySessionId(
  sessionId: string,
): Promise<SessionContextRecord[]> {
  const rows = await query<SessionContextRow[]>(
    "SELECT * FROM session_context WHERE session_id = ? ORDER BY `key`",
    [sessionId],
  );
  return rows.map(parseRow);
}

export async function findByKey(
  sessionId: string,
  key: string,
): Promise<SessionContextRecord | null> {
  const rows = await query<SessionContextRow[]>(
    "SELECT * FROM session_context WHERE session_id = ? AND `key` = ?",
    [sessionId, key],
  );
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}

export async function deleteBySessionId(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM session_context WHERE session_id = ?", [
    sessionId,
  ]);
}
