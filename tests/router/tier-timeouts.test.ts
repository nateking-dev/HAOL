import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { DEFAULT_TIMEOUT_MS } from "../../src/router/router.js";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { routeTask } from "../../src/router/router.js";
import * as executionService from "../../src/services/execution.js";
import type { ExecutionRecord } from "../../src/types/execution.js";

/* ------------------------------------------------------------------ */
/*  Unit tests — no DB required                                       */
/* ------------------------------------------------------------------ */

describe("DEFAULT_TIMEOUT_MS mapping", () => {
  it("has correct values for T1-T4", () => {
    expect(DEFAULT_TIMEOUT_MS[1]).toBe(15_000);
    expect(DEFAULT_TIMEOUT_MS[2]).toBe(30_000);
    expect(DEFAULT_TIMEOUT_MS[3]).toBe(60_000);
    expect(DEFAULT_TIMEOUT_MS[4]).toBe(120_000);
  });
});

/* ------------------------------------------------------------------ */
/*  Integration tests — require Dolt                                  */
/* ------------------------------------------------------------------ */

let doltAvailable = false;

function mockExecute(): { getCapturedTimeout: () => number | undefined; restore: () => void } {
  let capturedTimeout: number | undefined;
  const spy = vi.spyOn(executionService, "execute").mockImplementation(async (agentId, request) => {
    capturedTimeout = request.constraints.timeout_ms;
    return {
      execution_id: "timeout-test-exec",
      task_id: request.task_id,
      agent_id: agentId,
      attempt_number: 1,
      input_tokens: 50,
      output_tokens: 25,
      cost_usd: 0.001,
      latency_ms: 100,
      ttft_ms: 50,
      outcome: "SUCCESS",
      error_detail: null,
      response_content: "Done.",
    } satisfies ExecutionRecord;
  });
  return { getCapturedTimeout: () => capturedTimeout, restore: () => spy.mockRestore() };
}

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

    // Clear cascade router tables so classifyCascade falls back to old classifier
    await pool.query("DELETE FROM routing_rules");
    await pool.query("DELETE FROM routing_utterances");

    // Seed routing policy
    await pool.query(
      `INSERT IGNORE INTO routing_policy
         (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
       VALUES ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)`,
    );

    // Disable all non-tto agents to isolate tests
    await pool.query(
      "UPDATE agent_registry SET status = 'disabled' WHERE agent_id NOT LIKE 'tto-%'",
    );

    // Seed agents for tier-timeout tests
    await pool.query(
      `INSERT IGNORE INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES
         ('tto-haiku', 'anthropic', 'claude-haiku-4-5-20251001',
          '["classification","summarization","structured_output"]',
          0.000800, 0.004000, 200000, 300, 'active', 2),
         ('tto-sonnet', 'anthropic', 'claude-sonnet-4-5-20250514',
          '["code_generation","reasoning","structured_output","long_context"]',
          0.003000, 0.015000, 200000, 800, 'active', 4),
         ('tto-llama', 'local', 'llama-3.2-8b',
          '["summarization","classification"]',
          0.000000, 0.000000, 8192, 200, 'active', 1)`,
    );
  } catch (err) {
    console.warn("Dolt not available — skipping tier-timeout integration tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'tto-%'");
    await pool.query("DELETE FROM task_log WHERE selected_agent_id LIKE 'tto-%'");
    // Re-enable all previously disabled agents (safe: only changes 'disabled' → 'active')
    await pool.query("UPDATE agent_registry SET status = 'active' WHERE status = 'disabled'");
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'tto-%'");
  }
  await destroy();
});

describe("tier-based timeouts in routeTask", () => {
  it("T1 — uses 15s default", async ({ skip }) => {
    if (!doltAvailable) skip();

    const { getCapturedTimeout, restore } = mockExecute();

    const result = await routeTask({
      prompt: "Summarize this",
      metadata: { tier: 1 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(getCapturedTimeout()).toBe(15_000);
    restore();
  });

  it("T2 — uses 30s default", async ({ skip }) => {
    if (!doltAvailable) skip();

    const { getCapturedTimeout, restore } = mockExecute();

    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 2 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(getCapturedTimeout()).toBe(30_000);
    restore();
  });

  it("T3 — uses 60s default", async ({ skip }) => {
    if (!doltAvailable) skip();

    const { getCapturedTimeout, restore } = mockExecute();

    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 3 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(getCapturedTimeout()).toBe(60_000);
    restore();
  });

  it("T4 — uses 120s default", async ({ skip }) => {
    if (!doltAvailable) skip();

    const { getCapturedTimeout, restore } = mockExecute();

    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 4 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(getCapturedTimeout()).toBe(120_000);
    restore();
  });

  it("user-supplied timeout takes precedence over tier default", async ({ skip }) => {
    if (!doltAvailable) skip();

    const { getCapturedTimeout, restore } = mockExecute();

    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 1 },
      constraints: { timeout_ms: 5_000 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(getCapturedTimeout()).toBe(5_000);
    restore();
  });
});
