import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as outcomeRepo from "../../src/repositories/task-outcome.js";
import { uuidv7 } from "../../src/types/task.js";

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
    console.warn("Dolt not available — skipping task-outcome tests");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    await getPool().query(
      "DELETE FROM task_outcome WHERE task_id LIKE 'test-oc-%'",
    );
    await getPool().query(
      "DELETE FROM task_log WHERE task_id LIKE 'test-oc-%'",
    );
  }
  await destroy();
});

describe("task-outcome repository", () => {
  const ts = Date.now();

  it("inserts and retrieves a single outcome", async ({ skip }) => {
    if (!doltAvailable) skip();

    const taskId = `test-oc-single-${ts}`;
    const record = {
      outcome_id: uuidv7(),
      task_id: taskId,
      tier: 1 as const,
      source: "pipeline" as const,
      signal_type: "execution_success",
      signal_value: 1 as const,
      confidence: 0.95,
      detail: { reason: "completed normally" },
      reported_by: "test-harness",
    };

    await outcomeRepo.insert(record);
    const results = await outcomeRepo.findByTaskId(taskId);

    expect(results).toHaveLength(1);
    expect(results[0].outcome_id).toBe(record.outcome_id);
    expect(results[0].task_id).toBe(taskId);
    expect(results[0].tier).toBe(1);
    expect(results[0].source).toBe("pipeline");
    expect(results[0].signal_type).toBe("execution_success");
    expect(results[0].signal_value).toBe(1);
    expect(results[0].confidence).toBe(0.95);
    expect(results[0].detail).toEqual({ reason: "completed normally" });
    expect(results[0].reported_by).toBe("test-harness");
  });

  it("insertBatch inserts multiple outcomes", async ({ skip }) => {
    if (!doltAvailable) skip();

    const taskId = `test-oc-batch-${ts}`;
    const records = [
      {
        outcome_id: uuidv7(),
        task_id: taskId,
        tier: 0 as const,
        source: "format_check" as const,
        signal_type: "format_valid",
        signal_value: 1 as const,
        confidence: 1.0,
        detail: null,
        reported_by: null,
      },
      {
        outcome_id: uuidv7(),
        task_id: taskId,
        tier: 1 as const,
        source: "pipeline" as const,
        signal_type: "execution_success",
        signal_value: 1 as const,
        confidence: 0.9,
        detail: null,
        reported_by: "test-harness",
      },
      {
        outcome_id: uuidv7(),
        task_id: taskId,
        tier: 2 as const,
        source: "routing_eval" as const,
        signal_type: "routing_correct",
        signal_value: 0 as const,
        confidence: 0.6,
        detail: { note: "tier mismatch" },
        reported_by: "eval-system",
      },
    ];

    await outcomeRepo.insertBatch(records);
    const results = await outcomeRepo.findByTaskId(taskId);

    expect(results).toHaveLength(3);
  });

  it("findByTaskIdAndTier filters correctly", async ({ skip }) => {
    if (!doltAvailable) skip();

    const taskId = `test-oc-tier-${ts}`;

    await outcomeRepo.insert({
      outcome_id: uuidv7(),
      task_id: taskId,
      tier: 0 as const,
      source: "format_check" as const,
      signal_type: "format_valid",
      signal_value: 1 as const,
      confidence: 1.0,
      detail: null,
      reported_by: null,
    });

    await outcomeRepo.insert({
      outcome_id: uuidv7(),
      task_id: taskId,
      tier: 1 as const,
      source: "pipeline" as const,
      signal_type: "execution_success",
      signal_value: 1 as const,
      confidence: 0.85,
      detail: null,
      reported_by: "test-harness",
    });

    const tier0 = await outcomeRepo.findByTaskIdAndTier(taskId, 0);
    expect(tier0).toHaveLength(1);
    expect(tier0[0].tier).toBe(0);
    expect(tier0[0].signal_type).toBe("format_valid");

    const tier1 = await outcomeRepo.findByTaskIdAndTier(taskId, 1);
    expect(tier1).toHaveLength(1);
    expect(tier1[0].tier).toBe(1);
    expect(tier1[0].signal_type).toBe("execution_success");
  });

  it("findByTaskId returns empty array for nonexistent task", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const results = await outcomeRepo.findByTaskId("test-oc-nonexistent-999");
    expect(results).toEqual([]);
  });

  it("findTasksWithoutTier2Eval returns tasks below threshold", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    const taskId = `test-oc-lowconf-${ts}`;
    const pool = getPool();

    // Insert a task_log entry with low routing_confidence via raw SQL
    await pool.query(
      `INSERT INTO task_log (task_id, prompt_hash, status, routing_confidence, created_at)
       VALUES (?, 'hash123', 'COMPLETED', 0.35, NOW())`,
      [taskId],
    );

    // This task has no tier-2 outcome, so it should appear in low-confidence results
    const results = await outcomeRepo.findTasksWithoutTier2Eval(0.5, 24, 100);
    const match = results.find((r) => r.task_id === taskId);

    expect(match).toBeDefined();
    expect(match!.task_id).toBe(taskId);
    expect(match!.routing_confidence).toBe(0.35);
  });
});
