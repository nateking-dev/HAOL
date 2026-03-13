import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  query,
  healthCheck,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";

let doltAvailable = false;

beforeAll(async () => {
  const config = loadConfig();
  try {
    createPool(config.dolt);
    await query("SELECT 1");
    doltAvailable = true;
  } catch (err) {
    console.warn("Dolt not available — skipping connection integration tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  await destroy();
});

describe("connection", () => {
  it("connects and runs SELECT 1", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query("SELECT 1 AS val");
    expect(rows[0].val).toBe(1);
  });

  it("healthCheck returns true when connected", async ({ skip }) => {
    if (!doltAvailable) skip();
    const ok = await healthCheck();
    expect(ok).toBe(true);
  });
});
