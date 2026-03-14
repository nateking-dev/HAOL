import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import type { Hono } from "hono";

let doltAvailable = false;
let app: Hono;

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
    console.warn("Dolt not available — skipping observability maintenance API tests");
  }
  app = createApp();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM task_outcome WHERE task_id LIKE 'test-obm-%'");
    await pool.query("DELETE FROM task_log WHERE task_id LIKE 'test-obm-%'");
  }
  await destroy();
});

describe("GET /stats/orphaned-pending", () => {
  it("returns orphaned_pending count", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/stats/orphaned-pending");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.orphaned_pending).toBe("number");
    expect(body.max_age_hours).toBe(24);
  });

  it("accepts max_age_hours parameter", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/stats/orphaned-pending?max_age_hours=48");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.max_age_hours).toBe(48);
  });
});

describe("POST /maintenance/cleanup-pending", () => {
  it("returns deleted count with committed null when nothing deleted", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/maintenance/cleanup-pending", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.deleted).toBe("number");
    expect(body.max_age_hours).toBe(24);
    // committed is null when no rows were deleted (no commit attempted)
    if (body.deleted === 0) {
      expect(body.committed).toBeNull();
    } else {
      expect(typeof body.committed).toBe("boolean");
    }
  });

  it("accepts max_age_hours parameter", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/maintenance/cleanup-pending?max_age_hours=48", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.max_age_hours).toBe(48);
  });

  it("rejects unauthenticated requests when HAOL_API_KEY is set", async ({ skip }) => {
    if (!doltAvailable) skip();

    const originalKey = process.env.HAOL_API_KEY;
    process.env.HAOL_API_KEY = "test-secret-key";
    try {
      const res = await app.request("/maintenance/cleanup-pending", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    } finally {
      if (originalKey) {
        process.env.HAOL_API_KEY = originalKey;
      } else {
        delete process.env.HAOL_API_KEY;
      }
    }
  });

  it("allows authenticated requests when HAOL_API_KEY is set", async ({ skip }) => {
    if (!doltAvailable) skip();

    const originalKey = process.env.HAOL_API_KEY;
    process.env.HAOL_API_KEY = "test-secret-key";
    try {
      const res = await app.request("/maintenance/cleanup-pending", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret-key" },
      });
      expect(res.status).toBe(200);
    } finally {
      if (originalKey) {
        process.env.HAOL_API_KEY = originalKey;
      } else {
        delete process.env.HAOL_API_KEY;
      }
    }
  });
});
