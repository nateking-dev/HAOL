import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { getActivePolicy } from "../../src/repositories/routing-policy.js";
import { loadConfig } from "../../src/config.js";

let doltAvailable = false;

// Insert a routing_policy row with the given active flag. Columns mirror the
// seed; is_active_marker is generated and must not be set explicitly.
async function insertPolicy(policyId: string, active: boolean): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO routing_policy
       (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
     VALUES (?, 0.50, 0.30, 0.20, 'NEXT_BEST', 2, ?)`,
    [policyId, active],
  );
}

describe("routing_policy one-active constraint", () => {
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
      // Ensure a known active policy exists (seed may not have run).
      const pool = getPool();
      await pool.query(
        `INSERT IGNORE INTO routing_policy
           (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
         VALUES ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)`,
      );
    } catch {
      console.warn("Dolt not available — skipping routing_policy constraint tests");
    }
  });

  afterAll(async () => {
    if (doltAvailable) {
      const pool = getPool();
      await pool.query("DELETE FROM routing_policy WHERE policy_id LIKE 'test-rp-%'");
    }
    await destroy();
  });

  it("getActivePolicy returns the single active policy", async ({ skip }) => {
    if (!doltAvailable) skip();
    const policy = await getActivePolicy();
    expect(policy).not.toBeNull();
    expect(policy!.active).toBe(true);
  });

  it("rejects inserting a second active policy", async ({ skip }) => {
    if (!doltAvailable) skip();
    // An inactive row is always allowed (marker is NULL; NULLs may repeat).
    await insertPolicy("test-rp-inactive", false);
    // A second active row collides on uk_one_active.
    await expect(insertPolicy("test-rp-active2", true)).rejects.toThrow();
  });

  it("rejects activating a second policy via UPDATE", async ({ skip }) => {
    if (!doltAvailable) skip();
    await insertPolicy("test-rp-flip", false);
    const pool = getPool();
    await expect(
      pool.query("UPDATE routing_policy SET active = TRUE WHERE policy_id = 'test-rp-flip'"),
    ).rejects.toThrow();
  });

  it("allows many inactive policies to coexist", async ({ skip }) => {
    if (!doltAvailable) skip();
    await insertPolicy("test-rp-coexist1", false);
    await insertPolicy("test-rp-coexist2", false);
    await insertPolicy("test-rp-coexist3", false);
    const rows = await query<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM routing_policy WHERE policy_id LIKE 'test-rp-coexist%' AND active = FALSE",
    );
    expect(Number(rows[0].n)).toBe(3);
  });
});
