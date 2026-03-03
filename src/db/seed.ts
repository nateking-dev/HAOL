import { loadConfig } from "../config.js";
import { createPool, getPool, destroy } from "./connection.js";
import { doltCommit } from "./dolt.js";

const SEED_ROUTING_POLICY = `
INSERT IGNORE INTO routing_policy
  (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
VALUES
  ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)
`;

const SEED_AGENTS = `
INSERT IGNORE INTO agent_registry
  (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
VALUES
  ('claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5-20251001',
   '["classification","summarization","structured_output"]',
   0.000800, 0.004000, 200000, 300, 'active', 2),

  ('claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5-20250514',
   '["code_generation","reasoning","structured_output","long_context"]',
   0.003000, 0.015000, 200000, 800, 'active', 3),

  ('gpt-4o-mini', 'openai', 'gpt-4o-mini',
   '["classification","summarization","structured_output","multilingual"]',
   0.000150, 0.000600, 128000, 400, 'active', 2),

  ('local-llama', 'local', 'llama-3.2-8b',
   '["summarization","classification"]',
   0.000000, 0.000000, 8192, 200, 'active', 1)
`;

async function seed() {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }

  const pool = getPool();

  console.log("Seeding routing policy...");
  await pool.query(SEED_ROUTING_POLICY);

  console.log("Seeding sample agents...");
  await pool.query(SEED_AGENTS);

  await doltCommit({
    message: "seed: default routing policy + sample agents",
    author: "haol-seed <haol@system>",
  });

  console.log("Seed complete.");
  await destroy();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
