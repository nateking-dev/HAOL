import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import type { Hono } from "hono";

let doltAvailable = false;
let app: Hono;
const testAgentId = `api-test-${Date.now()}`;

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
  } catch {
    console.warn("Dolt not available — skipping agents API tests");
  }
  app = createApp();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query(
      "DELETE FROM agent_registry WHERE agent_id LIKE 'api-test-%'",
    );
  }
  await destroy();
});

describe("POST /agents", () => {
  it("creates an agent with valid body → 201", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: testAgentId,
        provider: "anthropic",
        model_id: "claude-haiku-4-5-20251001",
        capabilities: ["summarization", "classification"],
        cost_per_1k_input: 0.0008,
        cost_per_1k_output: 0.004,
        max_context_tokens: 200000,
        tier_ceiling: 2,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent_id).toBe(testAgentId);
    expect(body.status).toBe("active");
  });

  it("rejects invalid body → 400", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "bad" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /agents", () => {
  it("lists all agents", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by capability query param", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents?capability=summarization");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const agent of body) {
      expect(agent.capabilities).toContain("summarization");
    }
  });
});

describe("PUT /agents/:id", () => {
  it("updates agent fields → 200", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request(`/agents/${testAgentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avg_latency_ms: 999 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.avg_latency_ms).toBe(999);
  });

  it("returns 404 for non-existent agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents/non-existent-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avg_latency_ms: 100 }),
    });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /agents/:id", () => {
  it("soft-deletes an agent → 200", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request(`/agents/${testAgentId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);

    // Verify agent is disabled
    const getRes = await app.request("/agents?status=disabled");
    const body = await getRes.json();
    const disabled = body.find((a: Record<string, unknown>) => a.agent_id === testAgentId);
    expect(disabled).toBeTruthy();
    expect(disabled.status).toBe("disabled");
  });

  it("returns 404 for non-existent agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/agents/non-existent-agent", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});
