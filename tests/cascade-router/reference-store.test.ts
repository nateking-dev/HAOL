import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("reference-store", () => {
  it.skipIf(!doltAvailable)("loadConfig returns valid config shape", async () => {
    const { loadConfig: loadRouterConfig } = await import(
      "../../src/cascade-router/reference-store.js"
    );
    const config = await loadRouterConfig();

    expect(config).toHaveProperty("similarity_threshold");
    expect(config).toHaveProperty("escalation_threshold");
    expect(config).toHaveProperty("default_tier");
    expect(config).toHaveProperty("top_k");
    expect(typeof config.similarity_threshold).toBe("number");
  });

  it.skipIf(!doltAvailable)("loadRules returns an array", async () => {
    const { loadRules } = await import(
      "../../src/cascade-router/reference-store.js"
    );
    const rules = await loadRules();
    expect(Array.isArray(rules)).toBe(true);
  });

  it.skipIf(!doltAvailable)("loadUtterances returns an array", async () => {
    const { loadUtterances } = await import(
      "../../src/cascade-router/reference-store.js"
    );
    const utterances = await loadUtterances();
    expect(Array.isArray(utterances)).toBe(true);
  });

  it.skipIf(!doltAvailable)("hasEmbeddings returns a boolean", async () => {
    const { hasEmbeddings } = await import(
      "../../src/cascade-router/reference-store.js"
    );
    const result = await hasEmbeddings();
    expect(typeof result).toBe("boolean");
  });
});
