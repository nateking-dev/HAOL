import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as taskLog from "../../src/repositories/task-log.js";

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
    console.warn("Dolt not available — skipping task-log tests");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    await getPool().query(
      "DELETE FROM task_log WHERE task_id LIKE 'test-tl-%'",
    );
  }
  await destroy();
});

describe("task-log repository", () => {
  const testId = `test-tl-${Date.now()}`;

  it("creates a task_log entry with RECEIVED status", async ({ skip }) => {
    if (!doltAvailable) skip();

    await taskLog.create(testId, "abc123hash");
    const row = await taskLog.findById(testId);

    expect(row).not.toBeNull();
    expect(row!.task_id).toBe(testId);
    expect(row!.status).toBe("RECEIVED");
    expect(row!.prompt_hash).toBe("abc123hash");
    expect(row!.complexity_tier).toBeNull();
  });

  it("updates classification fields", async ({ skip }) => {
    if (!doltAvailable) skip();

    await taskLog.updateClassification(
      testId,
      2,
      ["code_generation", "reasoning"],
      0.05,
    );
    const row = await taskLog.findById(testId);

    expect(row!.status).toBe("CLASSIFIED");
    expect(row!.complexity_tier).toBe(2);
    expect(row!.required_capabilities).toEqual([
      "code_generation",
      "reasoning",
    ]);
    expect(row!.cost_ceiling_usd).toBeCloseTo(0.05);
  });

  it("updates selection fields", async ({ skip }) => {
    if (!doltAvailable) skip();

    await taskLog.updateSelection(testId, "claude-sonnet-4-5", {
      capability_score: 1.0,
      cost_score: 0.8,
      latency_score: 0.6,
      total_score: 0.84,
    });
    const row = await taskLog.findById(testId);

    expect(row!.status).toBe("DISPATCHED");
    expect(row!.selected_agent_id).toBe("claude-sonnet-4-5");
    expect(row!.selection_rationale).toEqual({
      capability_score: 1.0,
      cost_score: 0.8,
      latency_score: 0.6,
      total_score: 0.84,
    });
  });

  it("updates status to COMPLETED", async ({ skip }) => {
    if (!doltAvailable) skip();

    await taskLog.updateStatus(testId, "COMPLETED");
    const row = await taskLog.findById(testId);

    expect(row!.status).toBe("COMPLETED");
  });

  it("findById returns null for nonexistent task", async ({ skip }) => {
    if (!doltAvailable) skip();

    const row = await taskLog.findById("nonexistent-task-id");
    expect(row).toBeNull();
  });
});
