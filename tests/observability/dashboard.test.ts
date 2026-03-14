import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { getDashboard } from "../../src/observability/dashboard.js";

let doltAvailable = false;

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
    console.warn("Dolt not available — skipping dashboard tests");
  }
});

afterAll(async () => {
  await destroy();
});

describe("getDashboard", () => {
  it("returns all dashboard sections with correct shape", async ({ skip }) => {
    if (!doltAvailable) skip();

    const dashboard = await getDashboard(9999);

    expect(dashboard.period_hours).toBe(9999);
    expect(Array.isArray(dashboard.cost)).toBe(true);
    expect(Array.isArray(dashboard.latency)).toBe(true);
    expect(Array.isArray(dashboard.failures)).toBe(true);
    expect(Array.isArray(dashboard.tiers)).toBe(true);

    expect(dashboard.totals).toHaveProperty("total_cost");
    expect(dashboard.totals).toHaveProperty("total_invocations");
    expect(dashboard.totals).toHaveProperty("total_tasks");
    expect(dashboard.totals).toHaveProperty("avg_failure_rate");

    expect(typeof dashboard.totals.total_cost).toBe("number");
    expect(typeof dashboard.totals.avg_failure_rate).toBe("number");
  });

  it("handles empty time window gracefully", async ({ skip }) => {
    if (!doltAvailable) skip();

    const dashboard = await getDashboard(0);

    expect(dashboard.totals.total_cost).toBe(0);
    expect(dashboard.totals.total_invocations).toBe(0);
    expect(dashboard.totals.total_tasks).toBe(0);
    expect(dashboard.totals.avg_failure_rate).toBe(0);
  });
});
