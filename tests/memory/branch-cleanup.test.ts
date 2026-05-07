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
    // Clean up any task_log rows seeded by the active-task-guard tests.
    await pool.query("DELETE FROM task_log WHERE task_id LIKE 'cleanup-%'");
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

  it("never prunes a branch whose task is still in flight (active-task guard)", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    // Regression: previously the sweep deleted any session/% branch older
    // than the cutoff regardless of task state, so a long-running tier-4
    // task whose memory branch happened to be older than the retention
    // window would surface a cryptic Dolt "branch not found" on its next
    // memory step.

    const pool = getPool();
    const taskId = `cleanup-active-${Date.now()}`;
    const branchName = `session/${taskId}`;
    await doltBranch({ name: branchName });
    // Seed a non-terminal task_log row. status=DISPATCHED is the most
    // representative in-flight state.
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'DISPATCHED', ?)`,
      [taskId, "deadbeef"],
    );

    const pruned = await pruneSessionBranches(0);
    expect(pruned).not.toContain(branchName);

    const [after] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [branchName],
    );
    expect(after.length).toBe(1);
  });

  it("prunes a branch whose task has reached a terminal state", async ({ skip }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    const taskId = `cleanup-terminal-${Date.now()}`;
    const branchName = `session/${taskId}`;
    await doltBranch({ name: branchName });
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', ?)`,
      [taskId, "deadbeef"],
    );

    const pruned = await pruneSessionBranches(0);
    expect(pruned).toContain(branchName);
  });

  it("prunes orphan branches (no matching task_log row)", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Branch with no corresponding task_log row — safe to reclaim.
    const taskId = `cleanup-orphan-${Date.now()}`;
    const branchName = `session/${taskId}`;
    await doltBranch({ name: branchName });

    const pruned = await pruneSessionBranches(0);
    expect(pruned).toContain(branchName);
  });
});
