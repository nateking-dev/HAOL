import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  collectStructuralSignals,
  runFormatVerification,
  shouldSampleForEvaluation,
  evaluateRoutingDecision,
  recordDownstreamOutcome,
} from "../../src/services/outcome-collector.js";
import * as outcomeRepo from "../../src/repositories/task-outcome.js";
import * as taskLog from "../../src/repositories/task-log.js";
import type { ExecutionRecord } from "../../src/types/execution.js";
import type { TaskLogRecord } from "../../src/repositories/task-log.js";

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
    console.warn("Dolt not available — skipping integration tests");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM task_outcome WHERE task_id LIKE 'test-oco-%'");
    await pool.query("DELETE FROM task_log WHERE task_id LIKE 'test-oco-%'");
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'test-oco-%'");
  }
  await destroy();
});

// --- Pure function tests (no DB needed) ---

describe("shouldSampleForEvaluation", () => {
  it("returns true for confidence below 0.6", () => {
    expect(shouldSampleForEvaluation(0.3)).toBe(true);
  });

  it("returns false for confidence at or above 0.6", () => {
    expect(shouldSampleForEvaluation(0.6)).toBe(false);
    expect(shouldSampleForEvaluation(0.9)).toBe(false);
  });

  it("respects a custom threshold argument", () => {
    expect(shouldSampleForEvaluation(0.5, 0.8)).toBe(true);
    expect(shouldSampleForEvaluation(0.9, 0.8)).toBe(false);
    expect(shouldSampleForEvaluation(0.8, 0.8)).toBe(false);
  });

  it("handles boundary at exactly the threshold", () => {
    expect(shouldSampleForEvaluation(0.4, 0.4)).toBe(false);
    expect(shouldSampleForEvaluation(0.39, 0.4)).toBe(true);
  });
});

// --- Integration tests (require Dolt) ---

describe("runFormatVerification", () => {
  const testId = `test-oco-fmt-${Date.now()}`;

  it("setup: insert task_log entry", async ({ skip }) => {
    if (!doltAvailable) skip();
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-fmt')`,
      [testId],
    );
  });

  it("records json_valid=1 for valid JSON", async ({ skip }) => {
    if (!doltAvailable) skip();
    await runFormatVerification(testId, '{"key":"value"}', { type: "json" });
    const signals = await outcomeRepo.findByTaskIdAndTier(testId, 1);
    const jsonSignal = signals.find((s) => s.signal_type === "json_valid");
    expect(jsonSignal).toBeDefined();
    expect(jsonSignal!.signal_value).toBe(1);
    expect(jsonSignal!.tier).toBe(1);
  });

  it("records json_valid=0 for invalid JSON", async ({ skip }) => {
    if (!doltAvailable) skip();
    const fmtId = `test-oco-fmt2-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-fmt2')`,
      [fmtId],
    );
    await runFormatVerification(fmtId, "not json", { type: "json" });
    const signals = await outcomeRepo.findByTaskIdAndTier(fmtId, 1);
    const jsonSignal = signals.find((s) => s.signal_type === "json_valid");
    expect(jsonSignal).toBeDefined();
    expect(jsonSignal!.signal_value).toBe(0);
  });

  it("checks required_fields", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rfId = `test-oco-rf-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-rf')`,
      [rfId],
    );
    await runFormatVerification(rfId, '{"name":"test"}', {
      type: "json",
      required_fields: ["name", "age"],
    });
    const signals = await outcomeRepo.findByTaskIdAndTier(rfId, 1);
    const rfSignal = signals.find((s) => s.signal_type === "required_fields_present");
    expect(rfSignal).toBeDefined();
    expect(rfSignal!.signal_value).toBe(0);
    expect((rfSignal!.detail as Record<string, unknown>).missing).toEqual(["age"]);
  });

  it("checks length bounds", async ({ skip }) => {
    if (!doltAvailable) skip();
    const lbId = `test-oco-lb-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-lb')`,
      [lbId],
    );
    await runFormatVerification(lbId, "short", { min_length: 100 });
    const signals = await outcomeRepo.findByTaskIdAndTier(lbId, 1);
    const lbSignal = signals.find((s) => s.signal_type === "length_within_bounds");
    expect(lbSignal).toBeDefined();
    expect(lbSignal!.signal_value).toBe(0);
  });
});

describe("collectStructuralSignals", () => {
  const testId = `test-oco-struct-${Date.now()}`;
  const agentId = `test-oco-agent-${Date.now()}`;

  it("setup: insert task_log entry and test agent", async ({ skip }) => {
    if (!doltAvailable) skip();
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash, selected_agent_id, routing_confidence, complexity_tier)
       VALUES (?, 'COMPLETED', 'hash-struct', ?, 0.8, 2)`,
      [testId, agentId],
    );
    await pool.query(
      `INSERT INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES (?, 'anthropic', 'claude-haiku-4-5-20251001', ?, 0.25, 1.25, 200000, 500, 'active', 2)`,
      [agentId, JSON.stringify(["summarization"])],
    );
  });

  it("records clean_execution for successful run", async ({ skip }) => {
    if (!doltAvailable) skip();
    const execRecord: ExecutionRecord = {
      execution_id: "exec-1",
      task_id: testId,
      agent_id: agentId,
      attempt_number: 1,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      latency_ms: 500,
      ttft_ms: 100,
      outcome: "SUCCESS",
      error_detail: null,
      response_content: "test response",
    };
    const taskRecord: TaskLogRecord = {
      task_id: testId,
      created_at: new Date().toISOString(),
      status: "COMPLETED",
      prompt_hash: "test",
      complexity_tier: 2,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.05,
      selected_agent_id: agentId,
      selection_rationale: null,
      routing_confidence: 0.8,
      routing_layer: "semantic",
      expected_format: null,
    };
    await collectStructuralSignals(testId, [execRecord], taskRecord);
    const signals = await outcomeRepo.findByTaskIdAndTier(testId, 0);
    const cleanSignal = signals.find((s) => s.signal_type === "clean_execution");
    expect(cleanSignal).toBeDefined();
    expect(cleanSignal!.signal_value).toBe(1);
  });

  it("records error_occurred signal", async ({ skip }) => {
    if (!doltAvailable) skip();
    const errId = `test-oco-err-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'FAILED', 'hash-err')`,
      [errId],
    );
    const execRecord: ExecutionRecord = {
      execution_id: "exec-err",
      task_id: errId,
      agent_id: agentId,
      attempt_number: 1,
      input_tokens: 100,
      output_tokens: 0,
      cost_usd: 0.001,
      latency_ms: 500,
      ttft_ms: 100,
      outcome: "ERROR",
      error_detail: "something went wrong",
      response_content: null,
    };
    const taskRecord: TaskLogRecord = {
      task_id: errId,
      created_at: new Date().toISOString(),
      status: "FAILED",
      prompt_hash: "test",
      complexity_tier: 2,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.05,
      selected_agent_id: agentId,
      selection_rationale: null,
      routing_confidence: 0.8,
      routing_layer: "semantic",
      expected_format: null,
    };
    await collectStructuralSignals(errId, [execRecord], taskRecord);
    const signals = await outcomeRepo.findByTaskIdAndTier(errId, 0);
    const errSignal = signals.find((s) => s.signal_type === "error_occurred");
    expect(errSignal).toBeDefined();
    expect(errSignal!.signal_value).toBe(0);
  });

  it("records timeout_occurred signal", async ({ skip }) => {
    if (!doltAvailable) skip();
    const toId = `test-oco-to-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'FAILED', 'hash-to')`,
      [toId],
    );
    const execRecord: ExecutionRecord = {
      execution_id: "exec-to",
      task_id: toId,
      agent_id: agentId,
      attempt_number: 1,
      input_tokens: 100,
      output_tokens: 0,
      cost_usd: 0.001,
      latency_ms: 5000,
      ttft_ms: 0,
      outcome: "TIMEOUT",
      error_detail: "timeout",
      response_content: null,
    };
    const taskRecord: TaskLogRecord = {
      task_id: toId,
      created_at: new Date().toISOString(),
      status: "FAILED",
      prompt_hash: "test",
      complexity_tier: 2,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.05,
      selected_agent_id: agentId,
      selection_rationale: null,
      routing_confidence: 0.8,
      routing_layer: "semantic",
      expected_format: null,
    };
    await collectStructuralSignals(toId, [execRecord], taskRecord);
    const signals = await outcomeRepo.findByTaskIdAndTier(toId, 0);
    const toSignal = signals.find((s) => s.signal_type === "timeout_occurred");
    expect(toSignal).toBeDefined();
    expect(toSignal!.signal_value).toBe(0);
  });

  it("records cost_ceiling_breach", async ({ skip }) => {
    if (!doltAvailable) skip();
    const ccId = `test-oco-cc-${Date.now()}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-cc')`,
      [ccId],
    );
    const execRecord: ExecutionRecord = {
      execution_id: "exec-cc",
      task_id: ccId,
      agent_id: agentId,
      attempt_number: 1,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.05,
      latency_ms: 500,
      ttft_ms: 100,
      outcome: "SUCCESS",
      error_detail: null,
      response_content: "expensive response",
    };
    const taskRecord: TaskLogRecord = {
      task_id: ccId,
      created_at: new Date().toISOString(),
      status: "COMPLETED",
      prompt_hash: "test",
      complexity_tier: 2,
      required_capabilities: ["summarization"],
      cost_ceiling_usd: 0.01,
      selected_agent_id: agentId,
      selection_rationale: null,
      routing_confidence: 0.8,
      routing_layer: "semantic",
      expected_format: null,
    };
    await collectStructuralSignals(ccId, [execRecord], taskRecord);
    const signals = await outcomeRepo.findByTaskIdAndTier(ccId, 0);
    const ccSignal = signals.find((s) => s.signal_type === "cost_ceiling_breach");
    expect(ccSignal).toBeDefined();
    expect(ccSignal!.signal_value).toBe(0);
  });
});

describe("recordDownstreamOutcome", () => {
  const testId = `test-oco-ds-${Date.now()}`;

  it("setup: insert task_log entry", async ({ skip }) => {
    if (!doltAvailable) skip();
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash, routing_confidence) VALUES (?, 'COMPLETED', 'hash-ds', 0.8)`,
      [testId],
    );
  });

  it("records downstream outcome", async ({ skip }) => {
    if (!doltAvailable) skip();
    const result = await recordDownstreamOutcome(testId, {
      signal_type: "user_satisfied",
      signal_value: 1,
      reported_by: "test-system",
    });
    expect(result.task_id).toBe(testId);
    expect(result.tier).toBe(3);
    expect(result.source).toBe("downstream");
    expect(result.signal_type).toBe("user_satisfied");
    expect(result.signal_value).toBe(1);
    expect(result.reported_by).toBe("test-system");

    const signals = await outcomeRepo.findByTaskIdAndTier(testId, 3);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const dsSignal = signals.find((s) => s.signal_type === "user_satisfied");
    expect(dsSignal).toBeDefined();
  });

  it("throws for nonexistent task", async ({ skip }) => {
    if (!doltAvailable) skip();
    await expect(
      recordDownstreamOutcome("test-oco-nonexistent", {
        signal_type: "user_satisfied",
        signal_value: 1,
        reported_by: "test-system",
      }),
    ).rejects.toThrow("Task not found");
  });
});

describe("evaluateRoutingDecision — failure handling", () => {
  const testId = `test-oco-evalfail-${Date.now()}`;

  beforeAll(async () => {
    if (!doltAvailable) return;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash, routing_confidence, complexity_tier, routing_layer)
       VALUES (?, 'COMPLETED', 'hash-evalfail', 0.4, 2, 'semantic')`,
      [testId],
    );
  });

  it("inserts evaluation_failed record when LLM call fails", async ({ skip }) => {
    if (!doltAvailable) skip();
    // Set an invalid API key to force the provider to fail
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-invalid-key-for-testing";
    try {
      await evaluateRoutingDecision(testId);
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }

    const signals = await outcomeRepo.findByTaskIdAndTier(testId, 2);
    const pendingSignal = signals.find((s) => s.signal_type === "evaluation_pending");
    expect(pendingSignal).toBeDefined();

    const failedSignal = signals.find((s) => s.signal_type === "evaluation_failed");
    expect(failedSignal).toBeDefined();
    expect(failedSignal!.signal_value).toBeNull();
    expect(failedSignal!.detail).toBeDefined();
    expect((failedSignal!.detail as Record<string, unknown>).error).toBeDefined();
  });
});

describe("cleanupOrphanedPendingRecords", () => {
  // Use short suffixes to stay within VARCHAR(36)
  const ts = Date.now().toString(36);
  const orphanId = `test-oco-orph-${ts}`;
  const completeId = `test-oco-comp-${ts}`;

  beforeAll(async () => {
    if (!doltAvailable) return;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-cleanup1')`,
      [orphanId],
    );
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-cleanup2')`,
      [completeId],
    );

    // Insert an old orphaned pending record (backdated 48h)
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by, created_at)
       VALUES (?, ?, 2, 'routing_eval', 'evaluation_pending', NULL, 0.4, NULL, NULL, DATE_SUB(NOW(), INTERVAL 48 HOUR))`,
      [`test-oco-oid1-${ts}`, orphanId],
    );

    // Insert a pending + complete pair (should NOT be cleaned up)
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by, created_at)
       VALUES (?, ?, 2, 'routing_eval', 'evaluation_pending', NULL, 0.4, NULL, NULL, DATE_SUB(NOW(), INTERVAL 48 HOUR))`,
      [`test-oco-oid2-${ts}`, completeId],
    );
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by, created_at)
       VALUES (?, ?, 2, 'routing_eval', 'evaluation_complete', 1, 0.4, NULL, NULL, DATE_SUB(NOW(), INTERVAL 47 HOUR))`,
      [`test-oco-oid3-${ts}`, completeId],
    );
  });

  it("deletes only orphaned pending records", async ({ skip }) => {
    if (!doltAvailable) skip();
    const deleted = await outcomeRepo.cleanupOrphanedPendingRecords(24);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Orphaned record should be gone
    const orphanSignals = await outcomeRepo.findByTaskId(orphanId);
    const orphanPending = orphanSignals.find((s) => s.signal_type === "evaluation_pending");
    expect(orphanPending).toBeUndefined();

    // Completed pair's pending record should still exist
    const completeSignals = await outcomeRepo.findByTaskId(completeId);
    const completePending = completeSignals.find((s) => s.signal_type === "evaluation_pending");
    expect(completePending).toBeDefined();
  });
});

describe("countOrphanedPendingRecords", () => {
  const ts = Date.now().toString(36);
  const orphanId = `test-oco-cnt-${ts}`;

  beforeAll(async () => {
    if (!doltAvailable) return;
    const pool = getPool();
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'COMPLETED', 'hash-cnt')`,
      [orphanId],
    );
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value, confidence, detail, reported_by, created_at)
       VALUES (?, ?, 2, 'routing_eval', 'evaluation_pending', NULL, 0.4, NULL, NULL, DATE_SUB(NOW(), INTERVAL 48 HOUR))`,
      [`test-oco-coid-${ts}`, orphanId],
    );
  });

  it("counts orphaned pending records correctly", async ({ skip }) => {
    if (!doltAvailable) skip();
    const count = await outcomeRepo.countOrphanedPendingRecords(24);
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
