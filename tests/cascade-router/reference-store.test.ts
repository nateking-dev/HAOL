import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { clearConfigCache, safeParseThreshold } from "../../src/cascade-router/reference-store.js";
import { createPool, getPool, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";

let doltAvailable = false;

beforeAll(async () => {
  try {
    const config = loadConfig();
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }
    await getPool().query("SELECT 1");
    doltAvailable = true;
    await runMigrations();
  } catch {
    doltAvailable = false;
  }
});

afterAll(async () => {
  if (doltAvailable) {
    await destroy();
  }
});

beforeEach(() => clearConfigCache());

describe("reference-store", () => {
  it.skipIf(!doltAvailable)("loadConfig returns valid config shape", async () => {
    const { loadConfig: loadRouterConfig } =
      await import("../../src/cascade-router/reference-store.js");
    const config = await loadRouterConfig();

    expect(config).toHaveProperty("similarity_threshold");
    expect(config).toHaveProperty("escalation_threshold");
    expect(config).toHaveProperty("confidence_threshold");
    expect(config).toHaveProperty("default_tier");
    expect(config).toHaveProperty("top_k");
    expect(typeof config.similarity_threshold).toBe("number");
    expect(typeof config.confidence_threshold).toBe("number");
    expect(config.confidence_threshold).toBeGreaterThanOrEqual(0);
    expect(config.confidence_threshold).toBeLessThanOrEqual(1);
  });

  it.skipIf(!doltAvailable)("loadRules returns an array", async () => {
    const { loadRules } = await import("../../src/cascade-router/reference-store.js");
    const rules = await loadRules();
    expect(Array.isArray(rules)).toBe(true);
  });

  it.skipIf(!doltAvailable)("loadUtterances returns an array", async () => {
    const { loadUtterances } = await import("../../src/cascade-router/reference-store.js");
    const utterances = await loadUtterances();
    expect(Array.isArray(utterances)).toBe(true);
  });

  it.skipIf(!doltAvailable)("hasEmbeddings returns a boolean", async () => {
    const { hasEmbeddings } = await import("../../src/cascade-router/reference-store.js");
    const result = await hasEmbeddings();
    expect(typeof result).toBe("boolean");
  });

  it.skipIf(!doltAvailable)("loadConfig returns cached value on second call", async () => {
    const { loadConfig: loadRouterConfig } =
      await import("../../src/cascade-router/reference-store.js");
    clearConfigCache();
    const first = await loadRouterConfig();
    const second = await loadRouterConfig();
    // Same object reference means cache was used
    expect(second).toBe(first);
  });

  it.skipIf(!doltAvailable)("loadConfig re-fetches after cache is cleared", async () => {
    const { loadConfig: loadRouterConfig } =
      await import("../../src/cascade-router/reference-store.js");
    clearConfigCache();
    const first = await loadRouterConfig();
    clearConfigCache();
    const second = await loadRouterConfig();
    // Different object reference means a fresh fetch occurred
    expect(second).not.toBe(first);
    // But values should be equal
    expect(second).toEqual(first);
  });
});

describe("safeParseThreshold", () => {
  it("parses valid numeric strings", () => {
    expect(safeParseThreshold("0.72", 0.5)).toBe(0.72);
    expect(safeParseThreshold("0", 0.5)).toBe(0);
    expect(safeParseThreshold("1", 0.5)).toBe(1);
  });

  it("falls back to default for NaN inputs", () => {
    expect(safeParseThreshold("abc", 0.6)).toBe(0.6);
    expect(safeParseThreshold("", 0.6)).toBe(0.6);
    expect(safeParseThreshold(undefined, 0.6)).toBe(0.6);
  });

  it("falls back to default for Infinity", () => {
    expect(safeParseThreshold("Infinity", 0.6)).toBe(0.6);
    expect(safeParseThreshold("-Infinity", 0.6)).toBe(0.6);
  });

  it("clamps values to [0, 1]", () => {
    expect(safeParseThreshold("1.5", 0.6)).toBe(1);
    expect(safeParseThreshold("-0.1", 0.6)).toBe(0);
    expect(safeParseThreshold("2.0", 0.6)).toBe(1);
  });
});
