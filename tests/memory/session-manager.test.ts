import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { doltActiveBranch } from "../../src/db/dolt.js";
import {
  createSession,
  writeContext,
  readContext,
  commitSession,
  discardSession,
  writeHandoffSummary,
  readHandoffSummary,
} from "../../src/memory/session-manager.js";
import type { RowDataPacket } from "mysql2/promise";

let doltAvailable = false;
const testTaskId = `mem-test-${Date.now()}`;
const testTaskId2 = `mem-test2-${Date.now()}`;
const testTaskId3 = `mem-discard-${Date.now()}`;

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
    console.warn("Dolt not available — skipping session manager tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    // Ensure we're on main before cleanup
    const branch = await doltActiveBranch();
    if (branch !== "main") {
      await pool.query("CALL DOLT_CHECKOUT('main')");
    }

    // Clean up any leftover branches
    const [branches] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name LIKE 'session/mem-%'",
    );
    for (const b of branches) {
      try {
        await pool.query("CALL DOLT_BRANCH('-D', ?)", [b.name]);
      } catch {
        // ignore
      }
    }

    // Clean up context and handoff rows
    await pool.query(
      "DELETE FROM session_context WHERE session_id LIKE 'mem-%'",
    );
    await pool.query("DELETE FROM handoff_summary WHERE task_id LIKE 'mem-%'");
  }
  await destroy();
});

describe("session manager", () => {
  it("createSession creates a branch in dolt_branches", async ({ skip }) => {
    if (!doltAvailable) skip();

    const session = await createSession(testTaskId);
    expect(session.branch).toBe(`session/${testTaskId}`);

    // Verify branch exists
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [session.branch],
    );
    expect(rows.length).toBe(1);
  });

  it("writeContext writes data readable from the session branch", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const session = { taskId: testTaskId, branch: `session/${testTaskId}` };
    await writeContext(session, "agent_output", { result: "hello world" });

    // Should be back on main
    const branch = await doltActiveBranch();
    expect(branch).toBe("main");

    // Read back via readContext
    const value = await readContext(session, "agent_output");
    expect(value).toEqual({ result: "hello world" });
  });

  it("readContext without key returns all context entries", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const session = { taskId: testTaskId, branch: `session/${testTaskId}` };
    await writeContext(session, "second_key", [1, 2, 3]);

    const all = await readContext(session);
    expect(all).toEqual({
      agent_output: { result: "hello world" },
      second_key: [1, 2, 3],
    });
  });

  it("commitSession merges data to main and deletes branch", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const session = { taskId: testTaskId, branch: `session/${testTaskId}` };
    await commitSession(session);

    // Branch should be deleted
    const pool = getPool();
    const [branches] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [session.branch],
    );
    expect(branches.length).toBe(0);

    // Data should be visible on main
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM session_context WHERE session_id = ?",
      [testTaskId],
    );
    expect(rows.length).toBe(2);
  });

  it("discardSession preserves branch but data is not on main", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const session = await createSession(testTaskId3);
    await writeContext(session, "temp_data", "should not be on main");
    await discardSession(session);

    // Branch should still exist
    const pool = getPool();
    const [branches] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [session.branch],
    );
    expect(branches.length).toBe(1);

    // Data should NOT be on main
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM session_context WHERE session_id = ? AND `key` = 'temp_data'",
      [testTaskId3],
    );
    expect(rows.length).toBe(0);
  });

  it("concurrent sessions work independently", async ({ skip }) => {
    if (!doltAvailable) skip();

    const sessionA = await createSession(testTaskId2);
    const sessionB_id = `mem-concurrent-${Date.now()}`;
    const sessionB = await createSession(sessionB_id);

    await writeContext(sessionA, "from_a", "value_a");
    await writeContext(sessionB, "from_b", "value_b");

    const valA = await readContext(sessionA, "from_a");
    expect(valA).toBe("value_a");

    const valB = await readContext(sessionB, "from_b");
    expect(valB).toBe("value_b");

    // Commit both
    await commitSession(sessionA);
    await commitSession(sessionB);
  });
});

describe("handoff summary", () => {
  it("write and read handoff summary round-trips correctly", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const taskId = `mem-handoff-${Date.now()}`;
    await writeHandoffSummary(
      taskId,
      "agent-a",
      "Task partially completed, needs code review",
    );

    const result = await readHandoffSummary(taskId);
    expect(result).not.toBeNull();
    expect(result!.from_agent_id).toBe("agent-a");
    expect(result!.summary).toBe("Task partially completed, needs code review");
  });

  it("returns null for non-existent handoff", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await readHandoffSummary("non-existent-task");
    expect(result).toBeNull();
  });
});
