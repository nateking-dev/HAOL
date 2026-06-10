import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import { uuidv7 } from "../../src/types/task.js";
import type { Hono } from "hono";

let doltAvailable = false;
let app: Hono;

// Tag test rows via input_text instead of request_id, since request_id is
// VARCHAR(36) — exactly UUID-sized, no room for a prefix.
const TEST_INPUT_PREFIX = "TEST_CASCADE_OBS::";

beforeAll(async () => {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }
  try {
    await query("SELECT 1");
    // Only mark the suite as runnable once migrations succeed against a
    // real `haol` database — `SELECT 1` succeeds even without a database
    // selected, so the prior check is necessary but not sufficient.
    await runMigrations();
    doltAvailable = true;
  } catch {
    console.warn("Dolt + haol database not available — skipping cascade observability tests");
  }
  app = createApp();
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE ?", [`${TEST_INPUT_PREFIX}%`]);
  }
  await destroy();
});

async function seedRoutingLog(
  rows: Array<{
    layer: string;
    tier: number;
    latency: number;
    conf: number | null;
    sim: number | null;
  }>,
) {
  const pool = getPool();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO routing_log
         (log_id, request_id, input_text, routed_tier, routing_layer, similarity_score, confidence, latency_ms, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        uuidv7(),
        uuidv7(),
        `${TEST_INPUT_PREFIX}${r.layer}-${r.tier}`,
        r.tier,
        r.layer,
        r.sim,
        r.conf,
        r.latency,
      ],
    );
  }
}

describe("GET /observability/cascade", () => {
  it("returns the snapshot shape with zero-counts when no rows match", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Use a 1-hour window after cleaning out test data so we can assert zeros.
    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE ?", [`${TEST_INPUT_PREFIX}%`]);

    const res = await app.request("/v1/observability/cascade?hours=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("window_hours", 1);
    expect(body).toHaveProperty("snapshot_at");
    expect(typeof body.snapshot_at).toBe("string");
    expect(body).toHaveProperty("consistency", "best_effort");
    expect(body).toHaveProperty("total_decisions");
    expect(body).toHaveProperty("by_layer");
    const byLayer = body.by_layer as Record<string, unknown>;
    expect(Object.keys(byLayer).sort()).toEqual([
      "deterministic",
      "escalation",
      "fallback",
      "semantic",
    ]);
    expect(body).toHaveProperty("by_tier");
    expect(body).toHaveProperty("latency_ms");
    expect(body).toHaveProperty("near_misses");
    expect(Array.isArray(body.near_misses)).toBe(true);
  });

  it("aggregates seeded rows by layer", async ({ skip }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE ?", [`${TEST_INPUT_PREFIX}%`]);

    await seedRoutingLog([
      { layer: "deterministic", tier: 1, latency: 5, conf: 1.0, sim: null },
      { layer: "deterministic", tier: 1, latency: 6, conf: 1.0, sim: null },
      { layer: "semantic", tier: 2, latency: 80, conf: 0.78, sim: 0.74 },
      { layer: "escalation", tier: 3, latency: 450, conf: 0.85, sim: 0.4 },
      { layer: "fallback", tier: 3, latency: 0, conf: 0, sim: null },
    ]);

    const res = await app.request("/v1/observability/cascade?hours=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_decisions: number;
      by_layer: Record<string, { count: number; share: number }>;
      by_tier: Record<string, { count: number }>;
      near_misses: Array<{
        similarity_score: number;
        routing_layer: string;
        input_text_sha256: string;
        input_text?: string;
      }>;
    };

    expect(body.total_decisions).toBe(5);
    expect(body.by_layer.deterministic.count).toBe(2);
    expect(body.by_layer.semantic.count).toBe(1);
    expect(body.by_layer.escalation.count).toBe(1);
    expect(body.by_layer.fallback.count).toBe(1);

    expect(body.by_tier["1"].count).toBe(2);
    expect(body.by_tier["3"].count).toBe(2);

    // Near-misses include only escalation/fallback rows with a non-null
    // similarity_score — only the seeded escalation row qualifies.
    expect(body.near_misses.length).toBe(1);
    expect(body.near_misses[0].similarity_score).toBeCloseTo(0.4);
    expect(body.near_misses[0].routing_layer).toBe("escalation");
    // PII guard: hash always present, raw text omitted by default.
    expect(body.near_misses[0].input_text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.near_misses[0].input_text).toBeUndefined();
  });

  it("opts into raw input_text only when include_text=true AND disclosure is enabled", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE ?", [`${TEST_INPUT_PREFIX}%`]);
    await seedRoutingLog([{ layer: "escalation", tier: 3, latency: 450, conf: 0.85, sim: 0.4 }]);

    const prev = process.env.ALLOW_PROMPT_DISCLOSURE;
    process.env.ALLOW_PROMPT_DISCLOSURE = "1";
    try {
      const res = await app.request("/v1/observability/cascade?hours=1&include_text=true");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        near_misses: Array<{ input_text_sha256: string; input_text?: string }>;
      };
      expect(body.near_misses.length).toBe(1);
      expect(body.near_misses[0].input_text_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.near_misses[0].input_text).toBe(`${TEST_INPUT_PREFIX}escalation-3`);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_PROMPT_DISCLOSURE;
      else process.env.ALLOW_PROMPT_DISCLOSURE = prev;
    }
  });

  it("fails closed: include_text=true is ignored without ALLOW_PROMPT_DISCLOSURE", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    await pool.query("DELETE FROM routing_log WHERE input_text LIKE ?", [`${TEST_INPUT_PREFIX}%`]);
    await seedRoutingLog([{ layer: "escalation", tier: 3, latency: 450, conf: 0.85, sim: 0.4 }]);

    const prev = process.env.ALLOW_PROMPT_DISCLOSURE;
    delete process.env.ALLOW_PROMPT_DISCLOSURE;
    try {
      const res = await app.request("/v1/observability/cascade?hours=1&include_text=true");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        near_misses: Array<{ input_text_sha256: string; input_text?: string }>;
      };
      expect(body.near_misses.length).toBe(1);
      // Fingerprint still present, but the raw text is withheld.
      expect(body.near_misses[0].input_text_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.near_misses[0].input_text).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ALLOW_PROMPT_DISCLOSURE;
      else process.env.ALLOW_PROMPT_DISCLOSURE = prev;
    }
  });

  it("clamps the hours parameter to the valid range", async ({ skip }) => {
    if (!doltAvailable) skip();
    const res = await app.request("/v1/observability/cascade?hours=999999999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window_hours: number };
    expect(body.window_hours).toBe(2160); // MAX_HOURS — 90 days
  });
});

describe("GET /observability/cascade/timeseries", () => {
  it("returns hourly buckets by default", async ({ skip }) => {
    if (!doltAvailable) skip();
    const res = await app.request("/v1/observability/cascade/timeseries?hours=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bucket_hours: number; buckets: unknown[] };
    expect(body.bucket_hours).toBe(1);
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it("accepts bucket=day", async ({ skip }) => {
    if (!doltAvailable) skip();
    const res = await app.request("/v1/observability/cascade/timeseries?hours=24&bucket=day");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bucket_hours: number };
    expect(body.bucket_hours).toBe(24);
  });

  it("rejects unsupported bucket values with 400", async ({ skip }) => {
    if (!doltAvailable) skip();
    const res = await app.request("/v1/observability/cascade/timeseries?bucket=minute");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bucket/);
  });
});
