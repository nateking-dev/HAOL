import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { doltActiveBranch, doltBranch } from "../../src/db/dolt.js";
import { pruneSessionBranches } from "../../src/memory/branch-cleanup.js";
import type { RowDataPacket } from "mysql2/promise";

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
  } catch (err) {
    console.warn("Dolt not available — skipping branch cleanup tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    const branch = await doltActiveBranch();
    if (branch !== "main") {
      await pool.query("CALL DOLT_CHECKOUT('main')");
    }
    // Clean up any leftover test branches
    const [branches] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name LIKE 'session/cleanup-%'",
    );
    for (const b of branches) {
      try {
        await pool.query("CALL DOLT_BRANCH('-D', ?)", [b.name]);
      } catch {
        // ignore
      }
    }
  }
  await destroy();
});

describe("branch cleanup", () => {
  it("pruneSessionBranches(0) deletes old session branches", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Create a session branch
    const branchId = `cleanup-${Date.now()}`;
    await doltBranch({ name: `session/${branchId}` });

    // Verify it exists
    const pool = getPool();
    const [before] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [`session/${branchId}`],
    );
    expect(before.length).toBe(1);

    // Prune with retention 0 days — should delete immediately
    const pruned = await pruneSessionBranches(0);
    expect(pruned).toContain(`session/${branchId}`);

    // Verify it's gone
    const [after] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [`session/${branchId}`],
    );
    expect(after.length).toBe(0);
  });

  it("preserves branches within retention window", async ({ skip }) => {
    if (!doltAvailable) skip();

    const branchId = `cleanup-retain-${Date.now()}`;
    await doltBranch({ name: `session/${branchId}` });

    // Prune with retention 365 days — should NOT delete
    const pruned = await pruneSessionBranches(365);
    expect(pruned).not.toContain(`session/${branchId}`);

    // Clean up manually
    const pool = getPool();
    try {
      await pool.query("CALL DOLT_BRANCH('-D', ?)", [`session/${branchId}`]);
    } catch {
      // ignore
    }
  });
});
