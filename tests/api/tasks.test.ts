import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import type { Hono } from "hono";

let doltAvailable = false;
let app: Hono;
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
    // Ensure routing policy exists
    await pool.query(
      `INSERT IGNORE INTO routing_policy
         (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
       VALUES ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)`,
    );

    // Disable all non-api-task agents and seed test agents
    await pool.query(
      "UPDATE agent_registry SET status = 'disabled' WHERE agent_id NOT LIKE 'api-task-%'",
    );
    await pool.query(
      `INSERT IGNORE INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES
         ('api-task-haiku', 'anthropic', 'claude-haiku-4-5-20251001',
          '["classification","summarization","structured_output"]',
          0.000800, 0.004000, 200000, 300, 'active', 2),
         ('api-task-sonnet', 'anthropic', 'claude-sonnet-4-5-20250514',
          '["code_generation","reasoning","structured_output","long_context"]',
          0.003000, 0.015000, 200000, 800, 'active', 3)`,
    );
  } catch {
    console.warn("Dolt not available — skipping tasks API tests");
  }
  app = createApp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'api-task-%'");
    await pool.query("DELETE FROM task_log WHERE selected_agent_id LIKE 'api-task-%'");
    // Re-enable seed agents
    await pool.query(
      `UPDATE agent_registry SET status = 'active'
       WHERE agent_id IN ('claude-haiku-4-5','claude-sonnet-4-5','gpt-4o-mini','local-llama')`,
    );
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'api-task-%'");
  }
  await destroy();
});

describe("POST /tasks", () => {
  it("submits a task with valid prompt → 201", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Summary result");

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize this text about testing" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task_id).toBeTruthy();
    expect(body.status).toBe("COMPLETED");
    expect(body.response_content).toBe("Summary result");
  });

  it("rejects empty prompt → 400", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /tasks/:id", () => {
  it("returns task with current status", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Done.");

    // First create a task
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Classify this review" }),
    });
    const created = await createRes.json();

    // Then fetch it
    const res = await app.request(`/tasks/${created.task_id}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task_id).toBe(created.task_id);
    expect(body.status).toBe("COMPLETED");
    expect(body.executions).toBeTruthy();
  });

  it("returns 404 for non-existent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/non-existent-task-id");
    expect(res.status).toBe(404);
  });
});
