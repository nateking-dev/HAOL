import { query } from "../db/connection.js";
import { parseAgentRow } from "../repositories/agent-registry.js";
import { getActivePolicy } from "../repositories/routing-policy.js";
import type { RowDataPacket } from "mysql2/promise";
import type { AgentRegistration } from "../types/agent.js";
import type { TaskClassification } from "../types/task.js";
import type { RoutingPolicy, ScoredCandidate, SelectionResult } from "../types/selection.js";

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

function estimateCost(agent: AgentRegistration): number {
  return (1000 / 1000) * agent.cost_per_1k_input + (500 / 1000) * agent.cost_per_1k_output;
}

function hasAllCapabilities(
  agent: AgentRegistration,
  required: string[],
): boolean {
  return required.every((cap) => agent.capabilities.includes(cap));
}

async function filterCandidates(
  complexityTier: number,
  requiredCapabilities: string[],
  costCeiling: number,
): Promise<AgentRegistration[]> {
  const rows = await query<AgentRow[]>(
    "SELECT * FROM agent_registry WHERE status = 'active' AND tier_ceiling >= ?",
    [complexityTier],
  );

  const agents = rows.map(parseAgentRow);

  return agents.filter((agent) => {
    if (!hasAllCapabilities(agent, requiredCapabilities)) {
      return false;
    }
    const cost = estimateCost(agent);
    if (cost === 0) return true;
    return cost <= costCeiling;
  });
}

function scoreCandidates(
  candidates: AgentRegistration[],
  requiredCapabilities: string[],
  policy: RoutingPolicy,
): ScoredCandidate[] {
  const costs = candidates.map(estimateCost);
  const latencies = candidates.map((a) => a.avg_latency_ms);

  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);

  const costRange = maxCost - minCost;
  const latencyRange = maxLatency - minLatency;

  return candidates.map((agent, i) => {
    const capabilityScore =
      requiredCapabilities.length === 0
        ? 1.0
        : requiredCapabilities.filter((cap) => agent.capabilities.includes(cap)).length /
          requiredCapabilities.length;

    const costScore = costRange === 0 ? 1.0 : 1 - (costs[i] - minCost) / costRange;

    const latencyScore =
      latencyRange === 0
        ? 1.0
        : 1 - (agent.avg_latency_ms - minLatency) / latencyRange;

    const totalScore =
      capabilityScore * policy.weight_capability +
      costScore * policy.weight_cost +
      latencyScore * policy.weight_latency;

    return {
      agent_id: agent.agent_id,
      capability_score: capabilityScore,
      cost_score: costScore,
      latency_score: latencyScore,
      total_score: totalScore,
    };
  });
}

function sortCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.total_score !== a.total_score) {
      return b.total_score - a.total_score;
    }
    return a.agent_id.localeCompare(b.agent_id);
  });
}

export async function select(
  classification: TaskClassification,
  policy?: RoutingPolicy,
): Promise<SelectionResult> {
  if (!policy) {
    const loaded = await getActivePolicy();
    if (!loaded) {
      throw new Error("No active routing policy found");
    }
    policy = loaded;
  }

  // Step 1 + 2: Filter and score
  let candidates = await filterCandidates(
    classification.complexity_tier,
    classification.required_capabilities,
    classification.cost_ceiling_usd,
  );

  let scored = scoreCandidates(candidates, classification.required_capabilities, policy);
  let sorted = sortCandidates(scored);
  let fallbackApplied: "NONE" | "NEXT_BEST" | "TIER_UP" = "NONE";

  // Step 3: Fallback if no candidates
  if (sorted.length === 0) {
    if (policy.fallback_strategy === "NEXT_BEST") {
      const relaxedCeiling = classification.cost_ceiling_usd * 1.2;
      candidates = await filterCandidates(
        classification.complexity_tier,
        classification.required_capabilities,
        relaxedCeiling,
      );
      scored = scoreCandidates(candidates, classification.required_capabilities, policy);
      sorted = sortCandidates(scored);
      fallbackApplied = "NEXT_BEST";
    } else if (policy.fallback_strategy === "TIER_UP") {
      const higherTier = Math.min(classification.complexity_tier + 1, 4);
      candidates = await filterCandidates(
        higherTier,
        classification.required_capabilities,
        classification.cost_ceiling_usd,
      );
      scored = scoreCandidates(candidates, classification.required_capabilities, policy);
      sorted = sortCandidates(scored);
      fallbackApplied = "TIER_UP";
    }
    // fallback_strategy === 'ABORT' or still empty after fallback -> throw below
  }

  if (sorted.length === 0) {
    throw new Error("No agent available for task");
  }

  const winner = sorted[0];

  return {
    selected_agent_id: winner.agent_id,
    scored_candidates: sorted,
    rationale: {
      capability_score: winner.capability_score,
      cost_score: winner.cost_score,
      latency_score: winner.latency_score,
      total_score: winner.total_score,
    },
    fallback_applied: fallbackApplied,
  };
}
