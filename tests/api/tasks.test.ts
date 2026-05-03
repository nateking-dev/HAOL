import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { uuidv7 } from "../../src/types/task.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import * as worker from "../../src/services/task-worker.js";
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

async function pollUntilDone(
  taskId: string,
  timeoutMs = 10_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: Record<string, unknown> = {};
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await app.request(`/tasks/${taskId}`);
    lastStatus = res.status;
    lastBody = (await res.json()) as Record<string, unknown>;
    if (lastBody.done === true) {
      return { status: lastStatus, body: lastBody };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `Task ${taskId} did not finish within ${timeoutMs}ms — last status=${
      lastBody.status as string
    }`,
  );
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
  worker.start();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await worker.stop(2_000);
  worker._resetForTests();
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE '%trace test%'");
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'api-task-%'");
    await pool.query("DELETE FROM task_log WHERE selected_agent_id LIKE 'api-task-%'");
    // Best-effort cleanup of QUEUED rows we may have left without a selected_agent_id
    await pool.query("DELETE FROM task_log WHERE prompt LIKE '%trace test%'");
    await pool.query("DELETE FROM task_log WHERE prompt LIKE '%review%'");
    await pool.query("DELETE FROM task_log WHERE prompt LIKE '%testing%'");
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
  it("returns 202 + task_id immediately (does not block on LLM)", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Summary result");

    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize this text about testing" }),
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toMatch(/^\/tasks\/.+/);
    expect(res.headers.get("Retry-After")).toBe("1");

    const body = await res.json();
    expect(body.task_id).toBeTruthy();
    expect(body.status).toBe("QUEUED");
    expect(body.links?.self).toBe(`/tasks/${body.task_id}`);

    // Worker drains the queue and the task reaches COMPLETED.
    const polled = await pollUntilDone(body.task_id);
    expect(polled.body.status).toBe("COMPLETED");
    expect(polled.body.response_content).toBe("Summary result");
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
  it("returns task with current status (eventually COMPLETED)", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Done.");

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Classify this review" }),
    });
    const created = await createRes.json();

    const polled = await pollUntilDone(created.task_id);
    expect(polled.status).toBe(200);
    expect(polled.body.task_id).toBe(created.task_id);
    expect(polled.body.status).toBe("COMPLETED");
    expect(polled.body.done).toBe(true);
    expect(polled.body.executions).toBeTruthy();
    expect(polled.body.response_content).toBe("Done.");
  });

  it("returns 404 for non-existent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/non-existent-task-id");
    expect(res.status).toBe(404);
  });
});

describe("GET /tasks/:id/trace", () => {
  it("returns cascade trace for completed task", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockFetchSuccess("Trace test result");

    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize this article for trace test" }),
    });
    const created = await createRes.json();

    // Wait for the worker to finish so the task_log row is in a stable state
    await pollUntilDone(created.task_id);

    // Seed a routing_log entry with cascade_trace metadata for this task
    const cascadeTrace = {
      layers: [
        {
          layer: "deterministic",
          status: "missed",
          confidence: null,
          similarity_score: null,
          tier: null,
          reason: "no rule matched",
          latency_ms: 1,
        },
        {
          layer: "semantic",
          status: "matched",
          confidence: 0.88,
          similarity_score: 0.91,
          tier: 2,
          reason: "top-k hit",
          latency_ms: 12,
        },
        {
          layer: "escalation",
          status: "skipped",
          confidence: null,
          similarity_score: null,
          tier: null,
          reason: "already resolved",
          latency_ms: 0,
        },
        {
          layer: "fallback",
          status: "skipped",
          confidence: null,
          similarity_score: null,
          tier: null,
          reason: "already resolved",
          latency_ms: 0,
        },
      ],
      resolved_layer: "semantic",
      total_latency_ms: 13,
    };
    const pool = getPool();
    await pool.query(
      `INSERT INTO routing_log
         (log_id, request_id, input_text, routed_tier, routing_layer, similarity_score, confidence, latency_ms, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        created.task_id,
        "Summarize this article for trace test",
        2,
        "semantic",
        0.91,
        0.88,
        13,
        JSON.stringify({ cascade_trace: cascadeTrace }),
      ],
    );

    const res = await app.request(`/tasks/${created.task_id}/trace`);
    expect(res.status).toBe(200);

    const trace = await res.json();
    expect(trace.layers).toHaveLength(4);
    expect(trace.resolved_layer).toBeDefined();
    expect(typeof trace.total_latency_ms).toBe("number");

    // Verify layer order
    expect(trace.layers.map((l: any) => l.layer)).toEqual([
      "deterministic",
      "semantic",
      "escalation",
      "fallback",
    ]);

    // Each layer has required fields
    for (const attempt of trace.layers) {
      expect(["matched", "missed", "skipped", "error"]).toContain(attempt.status);
      expect(typeof attempt.reason).toBe("string");
    }
  });

  it("returns 404 for non-existent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/non-existent-id/trace");
    expect(res.status).toBe(404);
  });
});
