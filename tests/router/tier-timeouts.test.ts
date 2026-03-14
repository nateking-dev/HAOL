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

  it("returns undefined for unknown tiers", () => {
    expect(DEFAULT_TIMEOUT_MS[0]).toBeUndefined();
    expect(DEFAULT_TIMEOUT_MS[5]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Integration tests — require Dolt                                  */
/* ------------------------------------------------------------------ */

let doltAvailable = false;
const originalFetch = globalThis.fetch;

function mockFetchSuccess(content: string = "Mock response") {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("anthropic.com")) {
      return {
        ok: true,
        json: async () => ({
          content: [{ text: content }],
          usage: { input_tokens: 50, output_tokens: 25 },
          model: "mock-model",
          stop_reason: "end_turn",
        }),
      };
    }
    if (url.includes("openai.com")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 50, completion_tokens: 25 },
          model: "mock-model",
        }),
      };
    }
    // Ollama / local
    return {
      ok: true,
      json: async () => ({
        response: content,
        prompt_eval_count: 50,
        eval_count: 25,
        model: "mock-model",
      }),
    };
  }) as unknown as typeof fetch;
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
          0.003000, 0.015000, 200000, 800, 'active', 3),
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
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'tto-%'");
    await pool.query("DELETE FROM task_log WHERE selected_agent_id LIKE 'tto-%'");
    await pool.query(
      `UPDATE agent_registry SET status = 'active'
       WHERE agent_id IN ('claude-haiku-4-5','claude-sonnet-4-5','gpt-4o-mini','local-llama')`,
    );
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'tto-%'");
  }
  await destroy();
});

describe("tier-based timeouts in routeTask", () => {
  it("uses tier-appropriate default when no timeout specified", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Done.");

    let capturedTimeout: number | undefined;
    const executeSpy = vi
      .spyOn(executionService, "execute")
      .mockImplementation(async (agentId, request) => {
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

    // "Summarize this" triggers T1 classification (simple summarization)
    const result = await routeTask({ prompt: "Summarize this" });

    expect(result.status).toBe("COMPLETED");
    // T1 tasks should get 15s timeout
    expect(capturedTimeout).toBe(15_000);

    executeSpy.mockRestore();
  });

  it("uses T3 timeout for complex tasks", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Expert analysis.");

    let capturedTimeout: number | undefined;
    const executeSpy = vi
      .spyOn(executionService, "execute")
      .mockImplementation(async (agentId, request) => {
        capturedTimeout = request.constraints.timeout_ms;
        return {
          execution_id: "timeout-t3-exec",
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
          response_content: "Expert analysis.",
        } satisfies ExecutionRecord;
      });

    // Force T3 via metadata tier override
    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 3 },
    });

    expect(result.status).toBe("COMPLETED");
    expect(capturedTimeout).toBe(60_000);

    executeSpy.mockRestore();
  });

  it("user-supplied timeout takes precedence over tier default", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Done.");

    let capturedTimeout: number | undefined;
    const executeSpy = vi
      .spyOn(executionService, "execute")
      .mockImplementation(async (agentId, request) => {
        capturedTimeout = request.constraints.timeout_ms;
        return {
          execution_id: "timeout-override-exec",
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

    const result = await routeTask({
      prompt: "Summarize this",
      constraints: { timeout_ms: 5_000 },
    });

    expect(result.status).toBe("COMPLETED");
    // User specified 5s, should override the tier default
    expect(capturedTimeout).toBe(5_000);

    executeSpy.mockRestore();
  });
});
