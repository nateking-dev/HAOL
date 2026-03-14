import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { select } from "../../src/services/agent-selection.js";
import type { TaskClassification } from "../../src/types/task.js";
import type { RoutingPolicy } from "../../src/types/selection.js";

let doltAvailable = false;

beforeAll(async () => {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }
  try {
    await query("SELECT 1");
    doltAvailable = true;
    await runMigrations();

    // Disable any existing seed agents so they don't interfere with tests
    await getPool().query(
      `UPDATE agent_registry SET status = 'disabled' WHERE agent_id NOT LIKE 'sel-%'`,
    );

    // Insert test routing policy
    await getPool().query(
      `INSERT IGNORE INTO routing_policy (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
       VALUES ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)`,
    );

    // Insert test agents with sel- prefix
    await getPool().query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling) VALUES
        ('sel-haiku', 'anthropic', 'haiku', '["classification","summarization","structured_output"]', 0.000800, 0.004000, 200000, 300, 'active', 2),
        ('sel-sonnet', 'anthropic', 'sonnet', '["code_generation","reasoning","structured_output","long_context"]', 0.003000, 0.015000, 200000, 800, 'active', 3),
        ('sel-mini', 'openai', 'mini', '["classification","summarization","structured_output","multilingual"]', 0.000150, 0.000600, 128000, 400, 'active', 2),
        ('sel-llama', 'local', 'llama', '["summarization","classification"]', 0.000000, 0.000000, 8192, 200, 'active', 1)`,
    );
  } catch (err) {
    console.warn("Dolt not available — skipping agent-selection tests:", err);
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    // Remove test agents
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'sel-%'");
    // Re-enable any previously disabled seed agents
    await pool.query(
      `UPDATE agent_registry SET status = 'active' WHERE agent_id IN ('claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-4o-mini', 'local-llama')`,
    );
  }
  await destroy();
});

describe("agent-selection service", () => {
  it("default weights, T1 summarization — cheapest capable agent wins", async ({ skip }) => {
    if (!doltAvailable) skip();

    const classification: TaskClassification = {
      task_id: "test-t1-summarization",
      complexity_tier: 1,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.1,
      prompt_hash: "abc123",
    };

    const result = await select(classification);

    // sel-llama has cost 0, latency 200, and tier_ceiling 1 with summarization capability
    // With default weights (cap 0.5, cost 0.3, latency 0.2), the free + fast agent wins
    expect(result.selected_agent_id).toBe("sel-llama");
    expect(result.fallback_applied).toBe("NONE");
    expect(result.scored_candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("capability-heavy weights — agent with most matching capabilities wins", async ({ skip }) => {
    if (!doltAvailable) skip();

    const capHeavyPolicy: RoutingPolicy = {
      policy_id: "cap-heavy",
      weight_capability: 1.0,
      weight_cost: 0,
      weight_latency: 0,
      fallback_strategy: "NEXT_BEST",
      max_retries: 2,
      active: true,
    };

    const classification: TaskClassification = {
      task_id: "test-cap-heavy",
      complexity_tier: 2,
      required_capabilities: [
        "classification",
        "summarization",
        "structured_output",
        "multilingual",
      ],
      cost_ceiling_usd: 1.0,
      prompt_hash: "def456",
    };

    const result = await select(classification, capHeavyPolicy);

    // sel-mini has all 4 required capabilities, no bonus capabilities beyond required
    expect(result.selected_agent_id).toBe("sel-mini");
    // capability_score = 0.6 (base for having all required) + 0.4 * bonus ratio
    // No agent has bonus capabilities for this query, so bonus = 0
    expect(result.rationale.capability_score).toBe(0.6);
  });

  it("no capable agents with low cost ceiling — NEXT_BEST fallback relaxes cost", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    // sel-mini cost = (1 * 0.00015) + (0.5 * 0.0006) = 0.00015 + 0.0003 = 0.00045
    // Set ceiling just below that so first pass fails, but 20% relaxation allows it
    const tightCeiling = 0.0004; // too low for sel-mini (0.00045)
    // relaxed = 0.0004 * 1.2 = 0.00048 — enough for sel-mini (0.00045)

    const classification: TaskClassification = {
      task_id: "test-fallback-next-best",
      complexity_tier: 2,
      required_capabilities: [
        "classification",
        "summarization",
        "structured_output",
        "multilingual",
      ],
      cost_ceiling_usd: tightCeiling,
      prompt_hash: "ghi789",
    };

    const result = await select(classification);

    expect(result.selected_agent_id).toBe("sel-mini");
    expect(result.fallback_applied).toBe("NEXT_BEST");
  });

  it("no capable agents — ABORT throws", async ({ skip }) => {
    if (!doltAvailable) skip();

    const abortPolicy: RoutingPolicy = {
      policy_id: "abort-policy",
      weight_capability: 0.5,
      weight_cost: 0.3,
      weight_latency: 0.2,
      fallback_strategy: "ABORT",
      max_retries: 0,
      active: true,
    };

    const classification: TaskClassification = {
      task_id: "test-abort",
      complexity_tier: 1,
      required_capabilities: ["teleportation", "time_travel"],
      cost_ceiling_usd: 1.0,
      prompt_hash: "jkl012",
    };

    await expect(select(classification, abortPolicy)).rejects.toThrow(
      "No agent available for task",
    );
  });

  it("single candidate — all scores should be 1.0", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Use a very low cost ceiling so only sel-llama (cost 0) passes the filter
    const classification: TaskClassification = {
      task_id: "test-single",
      complexity_tier: 1,
      required_capabilities: ["summarization", "classification"],
      cost_ceiling_usd: 0.0001,
      prompt_hash: "mno345",
    };

    const result = await select(classification);

    expect(result.selected_agent_id).toBe("sel-llama");

    // With a single candidate, cost and latency normalize to 1.0.
    // Capability = 0.6 base (has all required) + 0.4 * bonus (0 bonus caps) = 0.6
    const winner = result.scored_candidates.find((c) => c.agent_id === "sel-llama");
    expect(winner).toBeDefined();
    expect(winner!.capability_score).toBe(0.6);
    expect(winner!.cost_score).toBe(1.0);
    expect(winner!.latency_score).toBe(1.0);
  });

  it("selection rationale contains per-dimension scores as numbers", async ({ skip }) => {
    if (!doltAvailable) skip();

    const classification: TaskClassification = {
      task_id: "test-rationale",
      complexity_tier: 1,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.1,
      prompt_hash: "pqr678",
    };

    const result = await select(classification);

    expect(typeof result.rationale.capability_score).toBe("number");
    expect(typeof result.rationale.cost_score).toBe("number");
    expect(typeof result.rationale.latency_score).toBe("number");
    expect(typeof result.rationale.total_score).toBe("number");

    // Scores should be between 0 and 1
    expect(result.rationale.capability_score).toBeGreaterThanOrEqual(0);
    expect(result.rationale.capability_score).toBeLessThanOrEqual(1);
    expect(result.rationale.cost_score).toBeGreaterThanOrEqual(0);
    expect(result.rationale.cost_score).toBeLessThanOrEqual(1);
    expect(result.rationale.latency_score).toBeGreaterThanOrEqual(0);
    expect(result.rationale.latency_score).toBeLessThanOrEqual(1);
  });

  it("TIER_UP fallback — unlocks higher-tier agents, not just higher cost ceiling", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const tierUpPolicy: RoutingPolicy = {
      policy_id: "tier-up",
      weight_capability: 0.5,
      weight_cost: 0.3,
      weight_latency: 0.2,
      fallback_strategy: "TIER_UP",
      max_retries: 0,
      active: true,
    };

    // T1 task requiring code_generation — sel-llama (tier_ceiling 1) doesn't have it,
    // so no T1-eligible agent qualifies. TIER_UP should raise to T2 and find sel-sonnet
    // (tier_ceiling 3) or sel-haiku (tier_ceiling 2).
    const classification: TaskClassification = {
      task_id: "test-tier-up",
      complexity_tier: 1,
      required_capabilities: ["code_generation"],
      cost_ceiling_usd: 0.01,
      prompt_hash: "tierup123",
    };

    const result = await select(classification, tierUpPolicy);

    expect(result.fallback_applied).toBe("TIER_UP");
    // sel-sonnet is the only agent with code_generation and tier_ceiling >= 2
    expect(result.selected_agent_id).toBe("sel-sonnet");
  });

  it("T4 task with multiple capabilities selects Opus agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Insert a T4-capable Opus agent
    await getPool().query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling) VALUES
        ('sel-opus', 'anthropic', 'opus', '["code_generation","reasoning","structured_output","long_context","tool_use","vision","multilingual"]', 0.015000, 0.075000, 1048576, 1200, 'active', 4)`,
    );

    const classification: TaskClassification = {
      task_id: "test-t4-multi-cap",
      complexity_tier: 4,
      required_capabilities: ["code_generation", "reasoning", "vision"],
      cost_ceiling_usd: 1.0,
      prompt_hash: "t4multi1",
    };

    const result = await select(classification);

    expect(result.selected_agent_id).toBe("sel-opus");
    expect(result.fallback_applied).toBe("NONE");
    expect(result.scored_candidates.length).toBe(1);

    // Clean up
    await getPool().query("DELETE FROM agent_registry WHERE agent_id = 'sel-opus'");
  });

  it("T4 task no longer fails with 'No agent available' when Opus agent exists", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    // First verify T4 fails without an Opus agent
    const classification: TaskClassification = {
      task_id: "test-t4-no-agent",
      complexity_tier: 4,
      required_capabilities: ["code_generation", "reasoning"],
      cost_ceiling_usd: 1.0,
      prompt_hash: "t4fail1",
    };

    const abortPolicy: RoutingPolicy = {
      policy_id: "abort-t4",
      weight_capability: 0.5,
      weight_cost: 0.3,
      weight_latency: 0.2,
      fallback_strategy: "ABORT",
      max_retries: 0,
      active: true,
    };

    await expect(select(classification, abortPolicy)).rejects.toThrow(
      "No agent available for task",
    );

    // Now insert the Opus agent and verify it succeeds
    await getPool().query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling) VALUES
        ('sel-opus', 'anthropic', 'opus', '["code_generation","reasoning","structured_output","long_context","tool_use","vision","multilingual"]', 0.015000, 0.075000, 1048576, 1200, 'active', 4)`,
    );

    const result = await select(classification, abortPolicy);

    expect(result.selected_agent_id).toBe("sel-opus");
    expect(result.fallback_applied).toBe("NONE");

    // Clean up
    await getPool().query("DELETE FROM agent_registry WHERE agent_id = 'sel-opus'");
  });

  it("TIER_UP fallback from T3 can reach T4 Opus agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Insert the Opus agent with T4 ceiling
    await getPool().query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling) VALUES
        ('sel-opus', 'anthropic', 'opus', '["code_generation","reasoning","structured_output","long_context","tool_use","vision","multilingual"]', 0.015000, 0.075000, 1048576, 1200, 'active', 4)`,
    );

    const tierUpPolicy: RoutingPolicy = {
      policy_id: "tier-up-t4",
      weight_capability: 0.5,
      weight_cost: 0.3,
      weight_latency: 0.2,
      fallback_strategy: "TIER_UP",
      max_retries: 0,
      active: true,
    };

    // T3 task requiring vision — sel-sonnet (tier_ceiling 3) doesn't have vision,
    // so TIER_UP should raise to T4 and find sel-opus
    const classification: TaskClassification = {
      task_id: "test-tier-up-t4",
      complexity_tier: 3,
      required_capabilities: ["vision"],
      cost_ceiling_usd: 1.0,
      prompt_hash: "tierupt4",
    };

    const result = await select(classification, tierUpPolicy);

    expect(result.fallback_applied).toBe("TIER_UP");
    expect(result.selected_agent_id).toBe("sel-opus");

    // Clean up
    await getPool().query("DELETE FROM agent_registry WHERE agent_id = 'sel-opus'");
  });

  it("tiebreak — identical scores, lower alphabetical agent_id wins", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Insert two agents with identical stats but different IDs
    await getPool().query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling) VALUES
        ('sel-tie-alpha', 'test', 'tie', '["tiebreak_test"]', 0.001000, 0.002000, 100000, 500, 'active', 2),
        ('sel-tie-beta', 'test', 'tie', '["tiebreak_test"]', 0.001000, 0.002000, 100000, 500, 'active', 2)`,
    );

    const classification: TaskClassification = {
      task_id: "test-tiebreak",
      complexity_tier: 2,
      required_capabilities: ["tiebreak_test"],
      cost_ceiling_usd: 1.0,
      prompt_hash: "stu901",
    };

    const equalPolicy: RoutingPolicy = {
      policy_id: "equal",
      weight_capability: 0.34,
      weight_cost: 0.33,
      weight_latency: 0.33,
      fallback_strategy: "ABORT",
      max_retries: 0,
      active: true,
    };

    const result = await select(classification, equalPolicy);

    // Both should have the same scores; alpha wins by alphabetical tiebreak
    expect(result.selected_agent_id).toBe("sel-tie-alpha");
    expect(result.scored_candidates.length).toBe(2);
    expect(result.scored_candidates[0].agent_id).toBe("sel-tie-alpha");
    expect(result.scored_candidates[1].agent_id).toBe("sel-tie-beta");

    // Clean up tiebreak agents
    await getPool().query(
      "DELETE FROM agent_registry WHERE agent_id IN ('sel-tie-alpha', 'sel-tie-beta')",
    );
  });
});
