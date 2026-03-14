import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { RoutingPolicy } from "../types/selection.js";

interface RoutingPolicyRow extends RowDataPacket {
  policy_id: string;
  weight_capability: string | number;
  weight_cost: string | number;
  weight_latency: string | number;
  fallback_strategy: string;
  max_retries: number;
  active: number | boolean;
  weight_outcome: string | number | null;
}

export async function getActivePolicy(): Promise<RoutingPolicy | null> {
  const rows = await query<RoutingPolicyRow[]>(
    "SELECT * FROM routing_policy WHERE active = TRUE LIMIT 1",
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    policy_id: row.policy_id,
    weight_capability:
      typeof row.weight_capability === "string"
        ? parseFloat(row.weight_capability)
        : row.weight_capability,
    weight_cost:
      typeof row.weight_cost === "string" ? parseFloat(row.weight_cost) : row.weight_cost,
    weight_latency:
      typeof row.weight_latency === "string" ? parseFloat(row.weight_latency) : row.weight_latency,
    fallback_strategy: row.fallback_strategy as RoutingPolicy["fallback_strategy"],
    max_retries: row.max_retries,
    active: row.active === 1 || row.active === true,
    weight_outcome: row.weight_outcome
      ? typeof row.weight_outcome === "string"
        ? parseFloat(row.weight_outcome)
        : row.weight_outcome
      : 0,
  };
}
