import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { uuidv7, sha256 } from "../../src/types/task.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as taskLog from "../../src/repositories/task-log.js";
import * as worker from "../../src/services/task-worker.js";
import { runReaperOnce } from "../../src/services/task-reaper.js";

let doltAvailable = false;
const originalFetch = globalThis.fetch;

const TEST_PROMPT_PREFIX = "[task-worker.test] ";

function mockProviderSuccess(content = "ok") {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("anthropic.com")) {
      return {
        ok: true,
        json: async () => ({
          content: [{ text: content }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "mock",
          stop_reason: "end_turn",
        }),
      };
    }
    if (url.includes("openai.com")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          model: "mock",
        }),
      };
    }
    return { ok: true, json: async () => ({ response: content, model: "mock" }) };
  }) as unknown as typeof fetch;
}

async function pollUntilDone(taskId: string, timeoutMs = 5_000): Promise<taskLog.TaskLogRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await taskLog.findById(taskId);
    if (row && (row.status === "COMPLETED" || row.status === "FAILED")) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Task ${taskId} did not finish within ${timeoutMs}ms`);
}

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
    const pool = getPool();
    // Seed minimal agent + policy needed by routeTask.
    await pool.query("DELETE FROM routing_rules");
    await pool.query("DELETE FROM routing_utterances");
    await pool.query(
      `INSERT IGNORE INTO routing_policy
         (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
       VALUES ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 0, TRUE)`,
    );
    await pool.query(
      "UPDATE agent_registry SET status = 'disabled' WHERE agent_id NOT LIKE 'wrk-test-%'",
    );
    await pool.query(
      `INSERT IGNORE INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES
         ('wrk-test-haiku', 'anthropic', 'claude-haiku-4-5-20251001',
          '["classification","summarization","structured_output"]',
          0.000800, 0.004000, 200000, 300, 'active', 2)`,
    );
  } catch {
    console.warn("Dolt not available — skipping task-worker tests");
  }
  worker.start();
});

afterAll(async () => {
  await worker.stop(2_000);
  worker._resetForTests();
  globalThis.fetch = originalFetch;
  if (doltAvailable) {
    const pool = getPool();
    // Collect task_ids for any session-side cleanup before deleting task_log
    // rows — pruneSessionBranches and the row deletes both key off task_id.
    const [taskRows] = await pool.query<RowDataPacket[]>(
      "SELECT task_id FROM task_log WHERE prompt LIKE ?",
      [`${TEST_PROMPT_PREFIX}%`],
    );
    for (const r of taskRows) {
      const id = r.task_id as string;
      try {
        await pool.query("CALL DOLT_BRANCH('-D', ?)", [`session/${id}`]);
      } catch {
        // branch may not exist (router skipped memory or already pruned)
      }
      await pool.query("DELETE FROM session_context WHERE session_id = ?", [id]);
    }
    await pool.query("DELETE FROM execution_log WHERE agent_id LIKE 'wrk-test-%'");
    await pool.query("DELETE FROM task_log WHERE prompt LIKE ?", [`${TEST_PROMPT_PREFIX}%`]);
    // Re-enable everything we disabled in beforeAll. Using the inverse of
    // the disable query (rather than a hardcoded agent list) avoids leaving
    // future seed agents disabled if the seed list grows.
    await pool.query(
      "UPDATE agent_registry SET status = 'active' WHERE agent_id NOT LIKE 'wrk-test-%'",
    );
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'wrk-test-%'");
  }
  await destroy();
});

describe("task-worker", () => {
  it("enqueue → row reaches COMPLETED with persisted response_content", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockProviderSuccess("worker-ran-it");

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}happy path`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });
    worker.enqueue(taskId, { prompt });

    const finished = await pollUntilDone(taskId);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.response_content).toBe("worker-ran-it");
    expect(finished.worker_started_at).not.toBeNull();
    expect(finished.worker_finished_at).not.toBeNull();
  });

  it("provider error → row reaches FAILED (routeTask handles its own errors)", async ({ skip }) => {
    if (!doltAvailable) skip();
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
      text: async () => "boom",
    })) as unknown as typeof fetch;

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}provider failure`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });
    worker.enqueue(taskId, { prompt });

    const finished = await pollUntilDone(taskId, 8_000);
    expect(finished.status).toBe("FAILED");
  });

  it("claimQueued is idempotent — duplicate enqueue does not double-execute", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockProviderSuccess("once");

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}duplicate enqueue`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });

    worker.enqueue(taskId, { prompt });
    worker.enqueue(taskId, { prompt });

    const finished = await pollUntilDone(taskId);
    expect(finished.status).toBe("COMPLETED");

    // Only one execution row should exist.
    const pool = getPool();
    const [rows] = await pool.query<Array<{ n: number }> & { 0: { n: number } }>(
      "SELECT COUNT(*) AS n FROM execution_log WHERE task_id = ?",
      [taskId],
    );
    const count = (rows as unknown as Array<{ n: number }>)[0].n;
    expect(Number(count)).toBe(1);
  });

  it("claimQueued DB error → row reaches FAILED with claim_failed worker_error", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();
    mockProviderSuccess("should-not-run");

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}claim failure`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });

    // Simulate a DB outage during the claim. The row must not be left stuck
    // in QUEUED — the worker should mark it FAILED so polling clients see a
    // terminal state without waiting for the reaper.
    const claimSpy = vi
      .spyOn(taskLog, "claimQueued")
      .mockRejectedValueOnce(new Error("connection lost"));
    try {
      worker.enqueue(taskId, { prompt });
      const finished = await pollUntilDone(taskId);
      expect(finished.status).toBe("FAILED");
      expect(finished.worker_error).toMatch(/^claim_failed: connection lost/);
      // routeTask must never have run for this task.
      const pool = getPool();
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM execution_log WHERE task_id = ?",
        [taskId],
      );
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      claimSpy.mockRestore();
    }
  });
});

describe("task-reaper", () => {
  it("re-enqueues stranded QUEUED rows on startup sweep", async ({ skip }) => {
    if (!doltAvailable) skip();
    mockProviderSuccess("recovered");

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}reaper requeue`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });
    // Note: we did NOT call worker.enqueue() — simulating a row that survived
    // a process restart while still in QUEUED.

    const stats = await runReaperOnce();
    expect(stats.reEnqueued).toBeGreaterThanOrEqual(1);

    const finished = await pollUntilDone(taskId);
    expect(finished.status).toBe("COMPLETED");
  });

  it("marks stale DISPATCHED rows FAILED with worker_crashed", async ({ skip }) => {
    if (!doltAvailable) skip();

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}reaper stale dispatch`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });

    // Force the row into a stale-DISPATCHED state by hand: bypass claimQueued
    // and backdate created_at past the recovery threshold.
    const pool = getPool();
    await pool.query(
      `UPDATE task_log
         SET status = 'DISPATCHED',
             selected_agent_id = 'wrk-test-haiku',
             created_at = NOW() - INTERVAL 1 DAY
       WHERE task_id = ?`,
      [taskId],
    );

    const stats = await runReaperOnce();
    expect(stats.failed).toBeGreaterThanOrEqual(1);

    const row = await taskLog.findById(taskId);
    expect(row?.status).toBe("FAILED");
    expect(row?.worker_error).toBe("worker_crashed");
  });

  it("does not reap rows whose worker_started_at is recent, even with old created_at", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    // Regression: previously findStale filtered on created_at, which is set
    // at intake. A task that sat in QUEUED for hours before a worker claimed
    // it would be killed seconds after pickup. The fix moves the age check
    // to worker_started_at (falling back to created_at for legacy rows).

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}reaper respects worker_started_at`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });

    const pool = getPool();
    await pool.query(
      `UPDATE task_log
         SET status = 'DISPATCHED',
             selected_agent_id = 'wrk-test-haiku',
             created_at = NOW() - INTERVAL 1 DAY,
             worker_started_at = NOW() - INTERVAL 5 SECOND
       WHERE task_id = ?`,
      [taskId],
    );

    await runReaperOnce();

    const row = await taskLog.findById(taskId);
    expect(row?.status).toBe("DISPATCHED");
    expect(row?.worker_error).toBeNull();
  });

  it("preserves session branch when reaping a stale row", async ({ skip }) => {
    if (!doltAvailable) skip();

    const taskId = uuidv7();
    const prompt = `${TEST_PROMPT_PREFIX}reaper preserves branch`;
    await taskLog.createQueued(taskId, sha256(prompt), { prompt });

    const pool = getPool();
    // Pre-create the session branch as the router would have, then backdate
    // the task row so the reaper marks it FAILED.
    await pool.query("CALL DOLT_BRANCH(?)", [`session/${taskId}`]);
    await pool.query(
      `UPDATE task_log
         SET status = 'DISPATCHED',
             selected_agent_id = 'wrk-test-haiku',
             created_at = NOW() - INTERVAL 1 DAY
       WHERE task_id = ?`,
      [taskId],
    );

    await runReaperOnce();

    const row = await taskLog.findById(taskId);
    expect(row?.status).toBe("FAILED");

    // The branch must survive the reap — pruneSessionBranches reclaims it
    // later, on retention expiry. Forensics on a freshly-failed task
    // depends on this.
    const [branches] = await pool.query<RowDataPacket[]>(
      "SELECT name FROM dolt_branches WHERE name = ?",
      [`session/${taskId}`],
    );
    expect(branches.length).toBe(1);
  });
});
