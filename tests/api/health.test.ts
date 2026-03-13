import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
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
  } catch {
    console.warn("Dolt not available — skipping health API tests");
  }
  app = createApp();
});

afterAll(async () => {
  await destroy();
});

describe("GET /health", () => {
  it("returns 200 when Dolt is connected", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.dolt).toBe("connected");
  });

  it("includes X-Request-ID header", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/health");
    expect(res.headers.get("X-Request-ID")).toBeTruthy();
  });

  it("uses provided X-Request-ID", async ({ skip }) => {
    if (!doltAvailable) skip();

    const res = await app.request("/health", {
      headers: { "X-Request-ID": "test-123" },
    });
    expect(res.headers.get("X-Request-ID")).toBe("test-123");
  });
});
