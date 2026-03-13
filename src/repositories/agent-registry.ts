import { query, getPool } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type {
  AgentRegistration,
  CreateAgentInput,
  UpdateAgentInput,
} from "../types/agent.js";

interface AgentRow extends RowDataPacket {
  agent_id: string;
  provider: string;
  model_id: string;
  capabilities: string | string[];
  cost_per_1k_input: string | number;
  cost_per_1k_output: string | number;
  max_context_tokens: number;
  avg_latency_ms: number;
  status: string;
  tier_ceiling: number;
}

export function parseAgentRow(row: AgentRow): AgentRegistration {
  let capabilities: string[];
  if (typeof row.capabilities === "string") {
    capabilities = JSON.parse(row.capabilities) as string[];
  } else {
    capabilities = row.capabilities;
  }

  return {
    agent_id: row.agent_id,
    provider: row.provider,
    model_id: row.model_id,
    capabilities,
    cost_per_1k_input:
      typeof row.cost_per_1k_input === "string"
        ? parseFloat(row.cost_per_1k_input)
        : row.cost_per_1k_input,
    cost_per_1k_output:
      typeof row.cost_per_1k_output === "string"
        ? parseFloat(row.cost_per_1k_output)
        : row.cost_per_1k_output,
    max_context_tokens: row.max_context_tokens,
    avg_latency_ms: row.avg_latency_ms,
    status: row.status as AgentRegistration["status"],
    tier_ceiling: row.tier_ceiling,
  };
}

export async function findAll(filters?: {
  status?: string;
  capability?: string;
}): Promise<AgentRegistration[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }

  if (filters?.capability) {
    conditions.push(`JSON_CONTAINS(capabilities, ?)`);
    params.push(JSON.stringify(filters.capability));
  }

  let sql = "SELECT * FROM agent_registry";
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  const rows = await query<AgentRow[]>(sql, params);
  return rows.map(parseAgentRow);
}

export async function findById(
  agentId: string,
): Promise<AgentRegistration | null> {
  const rows = await query<AgentRow[]>(
    "SELECT * FROM agent_registry WHERE agent_id = ?",
    [agentId],
  );
  if (rows.length === 0) return null;
  return parseAgentRow(rows[0]);
}

export async function findByCapabilities(
  caps: string[],
): Promise<AgentRegistration[]> {
  if (caps.length === 0) {
    return findAll({ status: "active" });
  }

  const jsonContains = caps
    .map(() => "JSON_CONTAINS(capabilities, ?)")
    .join(" AND ");
  const params = caps.map((c) => JSON.stringify(c));

  const sql = `SELECT * FROM agent_registry WHERE status = 'active' AND ${jsonContains}`;
  const rows = await query<AgentRow[]>(sql, params);
  return rows.map(parseAgentRow);
}

export async function create(input: CreateAgentInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_registry
       (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.agent_id,
      input.provider,
      input.model_id,
      JSON.stringify(input.capabilities),
      input.cost_per_1k_input,
      input.cost_per_1k_output,
      input.max_context_tokens,
      input.avg_latency_ms,
      input.status,
      input.tier_ceiling,
    ],
  );
}

export async function update(
  agentId: string,
  fields: UpdateAgentInput,
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  const entries = Object.entries(fields) as [keyof UpdateAgentInput, unknown][];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    setClauses.push(`${key} = ?`);
    if (key === "capabilities") {
      params.push(JSON.stringify(value));
    } else {
      params.push(value);
    }
  }

  if (setClauses.length === 0) return;

  params.push(agentId);
  const pool = getPool();
  await pool.query(
    `UPDATE agent_registry SET ${setClauses.join(", ")} WHERE agent_id = ?`,
    params,
  );
}

export async function remove(agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE agent_registry SET status = 'disabled' WHERE agent_id = ?",
    [agentId],
  );
}
