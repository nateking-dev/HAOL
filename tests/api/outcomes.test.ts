import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import type { Hono } from "hono";

let doltAvailable = false;
let app: Hono;
const testTaskId = `test-oapi-${Date.now()}`;
const emptyTaskId = `test-oapi-empty-${Date.now()}`;

beforeAll(async () => {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }
  try {
    await query("SELECT 1");
    await runMigrations();

    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash, routing_confidence, routing_layer)
       VALUES (?, 'COMPLETED', 'testhash', 0.75, 'semantic'),
              (?, 'COMPLETED', 'testhash', 0.80, 'semantic')`,
      [testTaskId, emptyTaskId],
    );
    doltAvailable = true;
  } catch {
    console.warn("Dolt not available — skipping outcomes API tests");
  }
  app = createApp();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM task_outcome WHERE task_id LIKE 'test-oapi-%'");
    await pool.query("DELETE FROM task_log WHERE task_id LIKE 'test-oapi-%'");
  }
  await destroy();
});

describe("POST /tasks/:id/outcome", () => {
  it("records downstream outcome → 201", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + testTaskId + "/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signal_type: "user_satisfied",
        signal_value: 1,
        reported_by: "test-system",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.outcome_id).toBeTruthy();
    expect(body.tier).toBe(3);
  });

  it("rejects invalid body → 400", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + testTaskId + "/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /tasks/:id/outcomes", () => {
  it("returns all outcomes for a task", async ({ skip }) => {
    if (!doltAvailable) skip();

    // First post an outcome to ensure at least one exists
    await app.request("/tasks/" + testTaskId + "/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signal_type: "quality_check",
        signal_value: 1,
        reported_by: "test-system",
      }),
    });

    const res = await app.request("/tasks/" + testTaskId + "/outcomes");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by tier", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + testTaskId + "/outcomes?tier=3");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const record of body) {
      expect(record.tier).toBe(3);
    }
  });

  it("returns empty array for valid task with no outcomes", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + emptyTaskId + "/outcomes");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("returns 404 for non-existent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/nonexistent-task-no-outcomes/outcomes");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain("Task not found");
  });
});

describe("GET /tasks/:id/outcomes/summary", () => {
  it("returns aggregated summary", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + testTaskId + "/outcomes/summary");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.total_signals).toBe("number");
    expect(typeof body.positive_signals).toBe("number");
    expect(typeof body.negative_signals).toBe("number");
    expect(body.by_tier).toBeTruthy();
    expect(typeof body.by_tier).toBe("object");
  });

  it("returns empty summary for valid task with no outcomes", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/" + emptyTaskId + "/outcomes/summary");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task_id).toBe(emptyTaskId);
    expect(body.total_signals).toBe(0);
  });

  it("returns 404 for non-existent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/tasks/nonexistent-task-no-summary/outcomes/summary");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain("Task not found");
  });
});
