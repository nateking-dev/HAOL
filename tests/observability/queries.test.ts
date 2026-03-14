import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  costByAgent,
  costCeilingBreaches,
  tasksByTier,
  avgLatencyByAgent,
  failureRate,
  commitHistory,
  agentRegistryDiff,
  outcomeSignalRates,
} from "../../src/observability/queries.js";

let doltAvailable = false;
const prefix = `obs-${Date.now()}`;

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

    const pool = getPool();

    // Seed task_log rows
    await pool.query(
      `INSERT IGNORE INTO task_log (task_id, status, prompt_hash, complexity_tier, required_capabilities, cost_ceiling_usd, selected_agent_id)
       VALUES
         ('${prefix}-t1', 'COMPLETED', 'hash1', 1, '["summarization"]', 0.01, '${prefix}-agent-a'),
         ('${prefix}-t2', 'COMPLETED', 'hash2', 2, '["reasoning"]', 0.05, '${prefix}-agent-b'),
         ('${prefix}-t3', 'COMPLETED', 'hash3', 3, '["code_generation"]', 0.50, '${prefix}-agent-a'),
         ('${prefix}-t4', 'FAILED', 'hash4', 1, '["summarization"]', 0.01, '${prefix}-agent-a')`,
    );

    // Seed execution_log rows
    await pool.query(
      `INSERT IGNORE INTO execution_log (execution_id, task_id, agent_id, attempt_number, input_tokens, output_tokens, cost_usd, latency_ms, ttft_ms, outcome, error_detail)
       VALUES
         ('${prefix}-e1', '${prefix}-t1', '${prefix}-agent-a', 1, 100, 50, 0.0050, 300, 100, 'SUCCESS', NULL),
         ('${prefix}-e2', '${prefix}-t2', '${prefix}-agent-b', 1, 200, 100, 0.0200, 800, 200, 'SUCCESS', NULL),
         ('${prefix}-e3', '${prefix}-t3', '${prefix}-agent-a', 1, 500, 250, 0.2000, 1200, 300, 'SUCCESS', NULL),
         ('${prefix}-e4', '${prefix}-t4', '${prefix}-agent-a', 1, 100, 0, 0.0000, 5000, 0, 'TIMEOUT', 'Connection timed out'),
         ('${prefix}-e5', '${prefix}-t4', '${prefix}-agent-a', 2, 100, 0, 0.0000, 5000, 0, 'ERROR', 'Server error')`,
    );

    // Seed task_outcome rows (for outcomeSignalRates)
    await pool.query(
      `INSERT IGNORE INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value)
       VALUES
         ('${prefix}-o1', '${prefix}-t1', 1, 'auto', 'accuracy', 1),
         ('${prefix}-o2', '${prefix}-t2', 2, 'auto', 'accuracy', 0),
         ('${prefix}-o3', '${prefix}-t3', 3, 'auto', 'accuracy', NULL),
         ('${prefix}-o4', '${prefix}-t1', 1, 'auto', 'latency', 1),
         ('${prefix}-o5', '${prefix}-t2', 2, 'auto', 'latency', 1)`,
    );
  } catch (err) {
    console.warn("Dolt not available — skipping observability tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query(
      `DELETE FROM task_outcome WHERE outcome_id LIKE '${prefix}-%'`,
    );
    await pool.query(
      `DELETE FROM execution_log WHERE task_id LIKE '${prefix}-%'`,
    );
    await pool.query(`DELETE FROM task_log WHERE task_id LIKE '${prefix}-%'`);
  }
  await destroy();
});

describe("costByAgent", () => {
  it("returns correct sums from seeded data", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await costByAgent(9999);
    const agentA = result.find((r) => r.agent_id === `${prefix}-agent-a`);
    const agentB = result.find((r) => r.agent_id === `${prefix}-agent-b`);

    expect(agentA).toBeTruthy();
    expect(agentA!.total_cost).toBeCloseTo(0.205, 3); // 0.005 + 0.200
    expect(agentA!.invocations).toBe(2);

    expect(agentB).toBeTruthy();
    expect(agentB!.total_cost).toBeCloseTo(0.02, 3);
    expect(agentB!.invocations).toBe(1);
  });
});

describe("costCeilingBreaches", () => {
  it("identifies tasks where cost exceeded ceiling", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await costCeilingBreaches();
    // t3 has ceiling 0.50 and cost 0.20 — no breach
    // t1 has ceiling 0.01 and cost 0.005 — no breach
    // No breaches expected with our seed data unless cost > ceiling
    // Let's check there are no false positives
    const ourBreaches = result.filter((r) => r.task_id.startsWith(prefix));
    // None of our tasks should breach (all costs < ceilings)
    expect(ourBreaches.length).toBe(0);
  });
});

describe("tasksByTier", () => {
  it("returns task counts grouped by tier", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await tasksByTier(9999);
    // We seeded: T1 x2, T2 x1, T3 x1 (at minimum from our prefix)
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const row of result) {
      expect(row.tier).toBeGreaterThanOrEqual(1);
      expect(row.tier).toBeLessThanOrEqual(4);
      expect(row.count).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("avgLatencyByAgent", () => {
  it("returns average latency per agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await avgLatencyByAgent(9999);
    const agentA = result.find((r) => r.agent_id === `${prefix}-agent-a`);

    expect(agentA).toBeTruthy();
    // agent-a has SUCCESS latencies: 300, 1200 → avg 750
    expect(agentA!.avg_latency_ms).toBeCloseTo(750, 0);
  });
});

describe("failureRate", () => {
  it("returns correct failure rates", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await failureRate(9999);
    const agentA = result.find((r) => r.agent_id === `${prefix}-agent-a`);

    expect(agentA).toBeTruthy();
    // agent-a: 4 total (e1 SUCCESS, e3 SUCCESS, e4 TIMEOUT, e5 ERROR), 2 failures
    expect(agentA!.total).toBe(4);
    expect(agentA!.failures).toBe(2);
    expect(agentA!.rate).toBeCloseTo(0.5, 2);
  });
});

describe("commitHistory", () => {
  it("returns recent Dolt commits", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await commitHistory(5);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].hash).toBeTruthy();
    expect(result[0].message).toBeTruthy();
    expect(result[0].date).toBeTruthy();
    expect(result[0].author).toBeTruthy();
  });
});

describe("agentRegistryDiff", () => {
  it("returns diff rows (may be empty if no recent changes)", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const result = await agentRegistryDiff("9999h");
    // Should return an array (possibly empty)
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("outcomeSignalRates", () => {
  it("excludes pending rows where signal_value IS NULL", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await outcomeSignalRates(9999);

    const accuracy = result.find((r) => r.signal_type === "accuracy");
    expect(accuracy).toBeTruthy();
    // Seeded: o1 (1), o2 (0), o3 (NULL) — NULL should be excluded
    expect(accuracy!.total).toBe(2);
    expect(accuracy!.positive).toBe(1);
    expect(accuracy!.negative).toBe(1);
    expect(accuracy!.rate).toBeCloseTo(0.5, 2);

    const latency = result.find((r) => r.signal_type === "latency");
    expect(latency).toBeTruthy();
    // Seeded: o4 (1), o5 (1) — both positive
    expect(latency!.total).toBe(2);
    expect(latency!.positive).toBe(2);
    expect(latency!.negative).toBe(0);
    expect(latency!.rate).toBeCloseTo(1.0, 2);
  });
});

describe("empty data handling", () => {
  it("queries return empty arrays when no data matches", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Use a tiny time window where no data exists
    const cost = await costByAgent(0);
    expect(Array.isArray(cost)).toBe(true);

    const tiers = await tasksByTier(0);
    expect(Array.isArray(tiers)).toBe(true);

    const latency = await avgLatencyByAgent(0);
    expect(Array.isArray(latency)).toBe(true);

    const failures = await failureRate(0);
    expect(Array.isArray(failures)).toBe(true);
  });
});
