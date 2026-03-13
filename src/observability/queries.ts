import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";

// --- Cost by agent ---

export interface CostByAgentRow {
  agent_id: string;
  total_cost: number;
  invocations: number;
}

interface CostByAgentRaw extends RowDataPacket {
  agent_id: string;
  total_cost: string | number;
  invocations: string | number;
}

export async function costByAgent(hours: number): Promise<CostByAgentRow[]> {
  const rows = await query<CostByAgentRaw[]>(
    `SELECT agent_id,
            SUM(cost_usd) AS total_cost,
            COUNT(*) AS invocations
     FROM execution_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND outcome = 'SUCCESS'
     GROUP BY agent_id
     ORDER BY total_cost DESC`,
    [hours],
  );
  return rows.map((r) => ({
    agent_id: r.agent_id,
    total_cost: typeof r.total_cost === "string" ? parseFloat(r.total_cost) : Number(r.total_cost),
    invocations:
      typeof r.invocations === "string" ? parseInt(r.invocations, 10) : Number(r.invocations),
  }));
}

// --- Cost ceiling breaches ---

export interface CostCeilingBreachRow {
  task_id: string;
  ceiling: number;
  actual_cost: number;
}

interface CostCeilingBreachRaw extends RowDataPacket {
  task_id: string;
  ceiling: string | number;
  actual_cost: string | number;
}

export async function costCeilingBreaches(): Promise<CostCeilingBreachRow[]> {
  const rows = await query<CostCeilingBreachRaw[]>(
    `SELECT t.task_id,
            t.cost_ceiling_usd AS ceiling,
            SUM(e.cost_usd) AS actual_cost
     FROM task_log t
     JOIN execution_log e ON e.task_id = t.task_id
     WHERE t.cost_ceiling_usd IS NOT NULL
     GROUP BY t.task_id, t.cost_ceiling_usd
     HAVING SUM(e.cost_usd) > t.cost_ceiling_usd
     ORDER BY actual_cost DESC`,
  );
  return rows.map((r) => ({
    task_id: r.task_id,
    ceiling: typeof r.ceiling === "string" ? parseFloat(r.ceiling) : Number(r.ceiling),
    actual_cost:
      typeof r.actual_cost === "string" ? parseFloat(r.actual_cost) : Number(r.actual_cost),
  }));
}

// --- Tasks by tier ---

export interface TasksByTierRow {
  tier: number;
  count: number;
}

interface TasksByTierRaw extends RowDataPacket {
  tier: number;
  count: string | number;
}

export async function tasksByTier(hours: number): Promise<TasksByTierRow[]> {
  const rows = await query<TasksByTierRaw[]>(
    `SELECT complexity_tier AS tier,
            COUNT(*) AS count
     FROM task_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND complexity_tier IS NOT NULL
     GROUP BY complexity_tier
     ORDER BY complexity_tier`,
    [hours],
  );
  return rows.map((r) => ({
    tier: r.tier,
    count:
      typeof r.count === "string" ? parseInt(r.count, 10) : Number(r.count),
  }));
}

// --- Average latency by agent ---

export interface AvgLatencyRow {
  agent_id: string;
  avg_latency_ms: number;
}

interface AvgLatencyRaw extends RowDataPacket {
  agent_id: string;
  avg_latency_ms: string | number;
}

export async function avgLatencyByAgent(
  hours: number,
): Promise<AvgLatencyRow[]> {
  const rows = await query<AvgLatencyRaw[]>(
    `SELECT agent_id,
            AVG(latency_ms) AS avg_latency_ms
     FROM execution_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND outcome = 'SUCCESS'
     GROUP BY agent_id
     ORDER BY avg_latency_ms`,
    [hours],
  );
  return rows.map((r) => ({
    agent_id: r.agent_id,
    avg_latency_ms:
      typeof r.avg_latency_ms === "string"
        ? parseFloat(r.avg_latency_ms)
        : Number(r.avg_latency_ms),
  }));
}

// --- Failure rate by agent ---

export interface FailureRateRow {
  agent_id: string;
  total: number;
  failures: number;
  rate: number;
}

interface FailureRateRaw extends RowDataPacket {
  agent_id: string;
  total: string | number;
  failures: string | number;
}

export async function failureRate(hours: number): Promise<FailureRateRow[]> {
  const rows = await query<FailureRateRaw[]>(
    `SELECT agent_id,
            COUNT(*) AS total,
            SUM(CASE WHEN outcome IN ('TIMEOUT','ERROR') THEN 1 ELSE 0 END) AS failures
     FROM execution_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY agent_id
     ORDER BY agent_id`,
    [hours],
  );
  return rows.map((r) => {
    const total =
      typeof r.total === "string" ? parseInt(r.total, 10) : Number(r.total);
    const failures =
      typeof r.failures === "string"
        ? parseInt(r.failures, 10)
        : Number(r.failures);
    return {
      agent_id: r.agent_id,
      total,
      failures,
      rate: total > 0 ? failures / total : 0,
    };
  });
}

// --- Agent registry diff ---

export interface AgentDiffRow {
  diff_type: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  from_status: string | null;
  to_status: string | null;
  from_capabilities: string | null;
  to_capabilities: string | null;
}

interface AgentDiffRaw extends RowDataPacket {
  diff_type: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  from_status: string | null;
  to_status: string | null;
  from_capabilities: string | null;
  to_capabilities: string | null;
}

export async function agentRegistryDiff(
  since: string,
): Promise<AgentDiffRow[]> {
  // Parse "7d", "24h", "1d" into a Dolt revision spec
  // Dolt supports: HEAD~N, commit hashes, timestamps
  // We'll use a commit-time-based approach via dolt_log
  const hoursAgo = parseDurationToHours(since);

  const rows = await query<AgentDiffRaw[]>(
    `SELECT diff_type,
            from_agent_id, to_agent_id,
            from_status, to_status,
            from_capabilities, to_capabilities
     FROM dolt_diff_agent_registry
     WHERE to_commit IN (
       SELECT commit_hash FROM dolt_log
       WHERE date >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     )
     ORDER BY to_agent_id`,
    [hoursAgo],
  );
  return rows.map((r) => ({
    diff_type: r.diff_type,
    from_agent_id: r.from_agent_id,
    to_agent_id: r.to_agent_id,
    from_status: r.from_status,
    to_status: r.to_status,
    from_capabilities: r.from_capabilities,
    to_capabilities: r.to_capabilities,
  }));
}

// --- Commit history ---

export interface CommitHistoryRow {
  hash: string;
  message: string;
  date: string;
  author: string;
}

interface CommitHistoryRaw extends RowDataPacket {
  commit_hash: string;
  message: string;
  date: string;
  committer: string;
}

export async function commitHistory(
  limit: number,
): Promise<CommitHistoryRow[]> {
  const rows = await query<CommitHistoryRaw[]>(
    `SELECT commit_hash, message, date, committer
     FROM dolt_log
     ORDER BY date DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    hash: r.commit_hash,
    message: r.message,
    date:
      typeof r.date === "object"
        ? (r.date as Date).toISOString()
        : String(r.date),
    author: r.committer,
  }));
}

// --- Outcome signal rates ---

export interface OutcomeSignalRateRow {
  signal_type: string;
  total: number;
  positive: number;
  negative: number;
  rate: number;
}

interface OutcomeSignalRateRaw extends RowDataPacket {
  signal_type: string;
  total: string | number;
  positive: string | number;
}

export async function outcomeSignalRates(
  hours: number,
): Promise<OutcomeSignalRateRow[]> {
  const rows = await query<OutcomeSignalRateRaw[]>(
    `SELECT signal_type,
            COUNT(*) AS total,
            SUM(CASE WHEN signal_value = 1 THEN 1 ELSE 0 END) AS positive
     FROM task_outcome
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY signal_type
     ORDER BY total DESC`,
    [hours],
  );
  return rows.map((r) => {
    const total =
      typeof r.total === "string" ? parseInt(r.total, 10) : Number(r.total);
    const positive =
      typeof r.positive === "string"
        ? parseInt(r.positive, 10)
        : Number(r.positive);
    return {
      signal_type: r.signal_type,
      total,
      positive,
      negative: total - positive,
      rate: total > 0 ? positive / total : 0,
    };
  });
}

// --- Routing accuracy by agent ---

export interface RoutingAccuracyRow {
  agent_id: string;
  total_outcomes: number;
  positive_outcomes: number;
  accuracy: number;
}

interface RoutingAccuracyRaw extends RowDataPacket {
  agent_id: string;
  total_outcomes: string | number;
  positive_outcomes: string | number;
}

export async function routingAccuracyByAgent(
  hours: number,
): Promise<RoutingAccuracyRow[]> {
  const rows = await query<RoutingAccuracyRaw[]>(
    `SELECT t.selected_agent_id AS agent_id,
            COUNT(*) AS total_outcomes,
            SUM(CASE WHEN o.signal_value = 1 THEN 1 ELSE 0 END) AS positive_outcomes
     FROM task_outcome o
     JOIN task_log t ON t.task_id = o.task_id
     WHERE o.tier IN (2, 3)
       AND o.signal_value IS NOT NULL
       AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND t.selected_agent_id IS NOT NULL
     GROUP BY t.selected_agent_id
     ORDER BY agent_id`,
    [hours],
  );
  return rows.map((r) => {
    const total =
      typeof r.total_outcomes === "string"
        ? parseInt(r.total_outcomes, 10)
        : Number(r.total_outcomes);
    const positive =
      typeof r.positive_outcomes === "string"
        ? parseInt(r.positive_outcomes, 10)
        : Number(r.positive_outcomes);
    return {
      agent_id: r.agent_id,
      total_outcomes: total,
      positive_outcomes: positive,
      accuracy: total > 0 ? positive / total : 0,
    };
  });
}

// --- Helpers ---

function parseDurationToHours(duration: string): number {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return 24; // default to 24 hours
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "d":
      return value * 24;
    case "h":
      return value;
    case "m":
      return value / 60;
    default:
      return 24;
  }
}
