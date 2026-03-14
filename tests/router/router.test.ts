import { describe, it, expect, beforeAll, afterAll, afterEach, onTestFinished, vi } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { routeTask } from "../../src/router/router.js";
import * as taskLog from "../../src/repositories/task-log.js";
import * as execLog from "../../src/repositories/execution-log.js";
import * as executionService from "../../src/services/execution.js";
import * as outcomeCollector from "../../src/services/outcome-collector.js";
import type { ExecutionRecord } from "../../src/types/execution.js";

let doltAvailable = false;
const originalFetch = globalThis.fetch;

/**
 * Mock fetch that responds correctly for both Anthropic and Ollama formats
 * based on the URL being called.
 */
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

function mockFetchFailure() {
  globalThis.fetch = vi.fn().mockImplementation(async () => ({
    ok: false,
    status: 500,
    text: async () => "Internal server error",
  })) as unknown as typeof fetch;
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

    // Disable all non-rtr agents to isolate tests
    await pool.query(
      "UPDATE agent_registry SET status = 'disabled' WHERE agent_id NOT LIKE 'rtr-%'",
    );

    // Seed agents for router tests
    await pool.query(
      `INSERT IGNORE INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES
         ('rtr-haiku', 'anthropic', 'claude-haiku-4-5-20251001',
          '["classification","summarization","structured_output"]',
          0.000800, 0.004000, 200000, 300, 'active', 2),
         ('rtr-sonnet', 'anthropic', 'claude-sonnet-4-5-20250514',
          '["code_generation","reasoning","structured_output","long_context"]',
          0.003000, 0.015000, 200000, 800, 'active', 3),
         ('rtr-llama', 'local', 'llama-3.2-8b',
          '["summarization","classification"]',
          0.000000, 0.000000, 8192, 200, 'active', 1)`,
    );
  } catch (err) {
    console.warn("Dolt not available — skipping router tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'rtr-%'");
    await pool.query("DELETE FROM task_log WHERE selected_agent_id LIKE 'rtr-%'");
    // Re-enable seed agents
    await pool.query(
      `UPDATE agent_registry SET status = 'active'
       WHERE agent_id IN ('claude-haiku-4-5','claude-sonnet-4-5','gpt-4o-mini','local-llama')`,
    );
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'rtr-%'");
  }
  await destroy();
});

describe("router pipeline", () => {
  it("completes full lifecycle for a summarization task", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Here is your summary.");

    const result = await routeTask({
      prompt: "Summarize this paragraph about testing",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.task_id).toBeTruthy();
    expect(result.complexity_tier).toBeGreaterThanOrEqual(1);
    expect(result.selected_agent_id).toBeTruthy();
    expect(result.response_content).toBe("Here is your summary.");
    expect(result.cost_usd).toBeGreaterThanOrEqual(0);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeNull();
  });

  it("task_log shows full lifecycle progression", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Done.");

    const result = await routeTask({ prompt: "Classify this review" });
    const row = await taskLog.findById(result.task_id);

    expect(row).not.toBeNull();
    expect(row!.status).toBe("COMPLETED");
    expect(row!.complexity_tier).toBeGreaterThanOrEqual(1);
    expect(row!.selected_agent_id).toBeTruthy();
    expect(row!.selection_rationale).toBeTruthy();
    expect(row!.prompt_hash).toBeTruthy();
  });

  it("execution_log has a row linked to the task", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Code output.");

    const result = await routeTask({ prompt: "Summarize this text" });
    const execRows = await execLog.findByTaskId(result.task_id);

    expect(execRows.length).toBeGreaterThanOrEqual(1);
    expect(execRows[0].task_id).toBe(result.task_id);
    expect(execRows[0].outcome).toBe("SUCCESS");
  });

  it("provider failure results in FAILED status", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchFailure();

    const result = await routeTask({ prompt: "Summarize this document" });

    expect(result.status).toBe("FAILED");
  });

  it("respects metadata tier override", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Expert analysis.");

    const result = await routeTask({
      prompt: "Hello",
      metadata: { tier: 3 },
    });

    expect(result.complexity_tier).toBe(3);
    // rtr-sonnet is the only rtr agent with tier_ceiling >= 3
    expect(result.selected_agent_id).toBe("rtr-sonnet");
  });

  it("handles no-agent-available gracefully", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess();

    const result = await routeTask({
      prompt: "Hello",
      metadata: { capabilities: ["teleportation"] },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toBeTruthy();
  });

  it("records synthetic error record when fallback execute throws", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Track what collectStructuralSignals receives
    let capturedRecords: ExecutionRecord[] = [];
    const signalsSpy = vi
      .spyOn(outcomeCollector, "collectStructuralSignals")
      .mockImplementation(async (_taskId, execRecords) => {
        capturedRecords = execRecords;
      });

    // First call to execute returns a failed record (triggers fallback);
    // second call throws (simulating a thrown fallback execution).
    let callCount = 0;
    const executeSpy = vi
      .spyOn(executionService, "execute")
      .mockImplementation(async (agentId, request) => {
        callCount++;
        if (callCount === 1) {
          // Primary execution fails with ERROR outcome
          return {
            execution_id: "primary-exec",
            task_id: request.task_id,
            agent_id: agentId,
            attempt_number: 1,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            latency_ms: 100,
            ttft_ms: 0,
            outcome: "ERROR",
            error_detail: "Primary provider down",
            response_content: null,
          } satisfies ExecutionRecord;
        }
        // Fallback execution throws
        throw new Error("Fallback connection refused");
      });

    onTestFinished(() => {
      executeSpy.mockRestore();
      signalsSpy.mockRestore();
    });

    const result = await routeTask({
      prompt: "Summarize this article about fallback testing",
    });

    expect(result.status).toBe("FAILED");

    // The synthetic record from the thrown fallback should be in the captured records
    expect(capturedRecords.length).toBe(2);
    expect(capturedRecords[0].outcome).toBe("ERROR");
    expect(capturedRecords[0].execution_id).toBe("primary-exec");
    expect(capturedRecords[1].outcome).toBe("ERROR");
    expect(capturedRecords[1].error_detail).toBe("Fallback connection refused");
    expect(capturedRecords[1].execution_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
