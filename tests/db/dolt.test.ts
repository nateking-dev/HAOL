import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { createPool, getPool, destroy, withBranchConnection } from "../../src/db/connection.js";
import {
  doltCommit,
  doltCheckout,
  doltBranch,
  doltDeleteBranch,
  doltMerge,
  doltActiveBranch,
  commitSafely,
} from "../../src/db/dolt.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";

let doltAvailable = false;

beforeAll(async () => {
  const config = loadConfig();
  try {
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }
    const pool = getPool();
    await pool.query("SELECT 1");
    doltAvailable = true;
    await runMigrations();
  } catch (err) {
    console.warn("Dolt not available — skipping dolt integration tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  await destroy();
});

describe("dolt helpers", () => {
  it("doltActiveBranch returns current branch", async ({ skip }) => {
    if (!doltAvailable) skip();
    const branch = await doltActiveBranch();
    expect(branch).toBe("main");
  });

  it("doltCommit creates a commit with allow-empty", async ({ skip }) => {
    if (!doltAvailable) skip();
    const hash = await doltCommit({
      message: "test: empty commit from vitest",
      author: "haol-test <test@haol>",
      allowEmpty: true,
    });
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
  });

  it("commitSafely (no allowEmpty) is a no-op when working set is clean", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Regression for audit #15: routerCommit dropped allowEmpty so a task
    // with no row changes shouldn't add a message-only entry to dolt_log.
    // commitSafely's responsibility is to swallow "nothing to commit"
    // silently; verify dolt_log doesn't grow when the working set is clean.
    const pool = getPool();

    // Ensure a clean baseline: flush whatever is staged so the next attempt
    // is genuinely empty.
    await commitSafely("test: baseline flush before empty-commit assertion", "test <t@t>", true);

    const [beforeRows] = (await pool.query("SELECT COUNT(*) AS n FROM dolt_log")) as [
      Array<{ n: number }>,
    ];
    const before = Number(beforeRows[0].n);

    await commitSafely(
      "test: this commit should NOT appear in dolt_log",
      "test <t@t>",
      // allowEmpty defaults to false
    );

    const [afterRows] = (await pool.query("SELECT COUNT(*) AS n FROM dolt_log")) as [
      Array<{ n: number }>,
    ];
    expect(Number(afterRows[0].n)).toBe(before);
  });

  it("doltCommit with tables[] stages only the listed tables", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Use an isolated branch so we don't fight with the rest of the suite
    // for working-set state on main.
    const testBranch = `test/dolt-tables-${Date.now()}`;
    const taskId = `dolt-tables-${Date.now()}`;

    await withBranchConnection(async (conn) => {
      await doltBranch({ name: testBranch }, conn);
      await doltCheckout(testBranch, conn);

      // Dirty two tables: session_context and handoff_summary.
      await conn.query(
        "INSERT INTO session_context (session_id, `key`, value) VALUES (?, 'k', JSON_OBJECT())",
        [taskId],
      );
      await conn.query(
        "INSERT INTO handoff_summary (task_id, from_agent_id, summary) VALUES (?, 'agent-x', 's')",
        [taskId],
      );

      // Commit only session_context.
      await doltCommit(
        {
          message: "test: commit only session_context",
          author: "haol-test <test@haol>",
          tables: ["session_context"],
        },
        conn,
      );

      // dolt_status should still show handoff_summary as dirty.
      const [statusRows] = await conn.query<RowDataPacket[]>("SELECT table_name FROM dolt_status");
      const dirtyTables = statusRows.map((r) => r.table_name as string);
      expect(dirtyTables).toContain("handoff_summary");
      expect(dirtyTables).not.toContain("session_context");

      // Cleanup: stage and commit the rest, return to main, drop branch.
      await doltCommit(
        {
          message: "test: cleanup",
          author: "haol-test <test@haol>",
          allowEmpty: true,
        },
        conn,
      );
      await conn.query("DELETE FROM session_context WHERE session_id = ?", [taskId]);
      await conn.query("DELETE FROM handoff_summary WHERE task_id = ?", [taskId]);
      await doltCommit(
        {
          message: "test: clear test rows",
          author: "haol-test <test@haol>",
          allowEmpty: true,
        },
        conn,
      );
      await doltCheckout("main", conn);
      // Force-delete: this branch was deliberately not merged into main, so
      // the safe `-d` form would refuse.
      await conn.query("CALL DOLT_BRANCH('-D', ?)", [testBranch]);
    });
  });

  it("doltBranch + doltCheckout + doltMerge lifecycle", async ({ skip }) => {
    if (!doltAvailable) skip();
    const testBranch = `test/story0-${Date.now()}`;

    await withBranchConnection(async (conn) => {
      // Create and switch to branch
      await doltBranch({ name: testBranch }, conn);
      await doltCheckout(testBranch, conn);

      const activeBranch = await doltActiveBranch(conn);
      expect(activeBranch).toBe(testBranch);

      // Make a commit on the branch
      await doltCommit(
        {
          message: "test: commit on branch",
          author: "haol-test <test@haol>",
          allowEmpty: true,
        },
        conn,
      );

      // Switch back and merge
      await doltCheckout("main", conn);
      const mergeResult = await doltMerge(testBranch, conn);
      expect(mergeResult.conflicts).toBe(0);

      // Cleanup
      await doltDeleteBranch(testBranch, conn);
    });
  });
});
