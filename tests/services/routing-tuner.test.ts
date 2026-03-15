import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  tune,
  extractKeyPhrases,
  escapeLike,
  aggregateOutcomesByAgentTier,
  recentTuningRuns,
  DEFAULT_TUNE_OPTIONS,
} from "../../src/services/routing-tuner.js";

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
    await pool.query("DELETE FROM tuning_run WHERE run_id LIKE 'test-tune-%'");
    await pool.query("DELETE FROM routing_rules WHERE description LIKE 'Auto-crystallized%'");
    await pool.query("DELETE FROM routing_utterances WHERE source = 'tuner'");
    await pool.query("DELETE FROM task_outcome WHERE task_id LIKE 'test-tune-%'");
    await pool.query("DELETE FROM routing_log WHERE request_id LIKE 'test-tune-%'");
    await pool.query("DELETE FROM task_log WHERE task_id LIKE 'test-tune-%'");
  }
  await destroy();
});

// ---------------------------------------------------------------------------
// Pure function tests (no DB)
// ---------------------------------------------------------------------------

describe("extractKeyPhrases", () => {
  it("returns phrases appearing in at least minFrequency prompts", () => {
    const prompts = [
      "analyze the kubernetes deployment configuration",
      "check kubernetes pod status",
      "debug the kubernetes network policy",
      "what time is it",
    ];
    const result = extractKeyPhrases(prompts, 3);
    expect(result.has("kubernetes")).toBe(true);
    expect(result.get("kubernetes")).toBe(3);
  });

  it("filters out stop words", () => {
    const prompts = [
      "please help with this problem",
      "help me with this issue",
      "please help about this thing",
    ];
    const result = extractKeyPhrases(prompts, 3);
    expect(result.size).toBe(0);
  });

  it("filters out short words (< 4 chars)", () => {
    const prompts = ["the api has a bug", "fix api bug now", "api bug report"];
    const result = extractKeyPhrases(prompts, 3);
    expect(result.has("api")).toBe(false);
    expect(result.has("bug")).toBe(false);
  });

  it("returns empty map when no phrases meet threshold", () => {
    const prompts = [
      "one unique sentence",
      "another different phrase",
      "yet another distinct input",
    ];
    const result = extractKeyPhrases(prompts, 3);
    expect(result.size).toBe(0);
  });

  it("counts document frequency not term frequency", () => {
    const prompts = ["kubernetes kubernetes kubernetes", "something else entirely"];
    const result = extractKeyPhrases(prompts, 2);
    expect(result.has("kubernetes")).toBe(false);
  });
});

describe("escapeLike", () => {
  it("escapes percent signs", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapes underscores", () => {
    expect(escapeLike("deploy_prod")).toBe("deploy\\_prod");
  });

  it("escapes backslashes", () => {
    expect(escapeLike("path\\to")).toBe("path\\\\to");
  });

  it("passes through normal strings unchanged", () => {
    expect(escapeLike("kubernetes")).toBe("kubernetes");
  });

  it("escapes multiple metacharacters in one string", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});

describe("DEFAULT_TUNE_OPTIONS", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_TUNE_OPTIONS.hours).toBe(72);
    expect(DEFAULT_TUNE_OPTIONS.minSampleSize).toBe(5);
    expect(DEFAULT_TUNE_OPTIONS.minPatternFrequency).toBe(3);
    expect(DEFAULT_TUNE_OPTIONS.crystallizeConfidenceThreshold).toBe(0.8);
    expect(DEFAULT_TUNE_OPTIONS.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require Dolt)
// ---------------------------------------------------------------------------

describe("tune (dry run)", () => {
  it("runs a dry-run tune cycle with no side effects", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await tune({ dryRun: true, hours: 1 });

    expect(result.status).toBe("dry_run");
    expect(result.run_id).toBeDefined();
    expect(result.hours_window).toBe(1);
    expect(result.tasks_analyzed).toBeGreaterThanOrEqual(0);
    expect(result.signals_used).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.agent_tier_outcomes)).toBe(true);
    expect(Array.isArray(result.rules_created)).toBe(true);
    expect(Array.isArray(result.utterances_added)).toBe(true);

    // Verify no tuning_run record was created
    const rows = await query<any[]>(`SELECT * FROM tuning_run WHERE run_id = ?`, [result.run_id]);
    expect(rows.length).toBe(0);
  });
});

describe("aggregateOutcomesByAgentTier", () => {
  it("returns empty array when no outcomes exist in window", async ({ skip }) => {
    if (!doltAvailable) skip();

    const results = await aggregateOutcomesByAgentTier(0);
    expect(Array.isArray(results)).toBe(true);
  });

  it("aggregates seeded outcome data correctly", async ({ skip }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    const agentId = "test-tune-agent-agg";
    const taskId = "test-tune-task-agg";

    await pool.query(
      `INSERT IGNORE INTO agent_registry (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES (?, 'test', 'test-model', '["code"]', 0.01, 0.02, 4096, 500, 'active', 4)`,
      [agentId],
    );
    await pool.query(
      `INSERT IGNORE INTO task_log (task_id, prompt_hash, complexity_tier, required_capabilities, cost_ceiling_usd, selected_agent_id, status)
       VALUES (?, 'hash-agg', 3, '["code"]', 0.50, ?, 'completed')`,
      [taskId, agentId],
    );
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value)
       VALUES (?, ?, 0, 'pipeline', 'clean_execution', 1)`,
      [`test-tune-oc-agg-1`, taskId],
    );
    await pool.query(
      `INSERT INTO task_outcome (outcome_id, task_id, tier, source, signal_type, signal_value)
       VALUES (?, ?, 1, 'format_check', 'json_valid', 1)`,
      [`test-tune-oc-agg-2`, taskId],
    );

    const results = await aggregateOutcomesByAgentTier(24);
    const match = results.find((r) => r.agent_id === agentId && r.complexity_tier === 3);
    expect(match).toBeDefined();
    // Per-task aggregation: 2 signals for the same task collapse to 1
    // positive task (MIN of signal_values, both are 1 → task_signal=1)
    expect(match!.positive).toBeGreaterThanOrEqual(1);
    expect(match!.total).toBeGreaterThanOrEqual(1);
    expect(match!.success_rate).toBeGreaterThan(0);

    // Cleanup
    await pool.query("DELETE FROM task_outcome WHERE task_id = ?", [taskId]);
    await pool.query("DELETE FROM task_log WHERE task_id = ?", [taskId]);
    await pool.query("DELETE FROM agent_registry WHERE agent_id = ?", [agentId]);
  });
});

describe("tune (live run)", () => {
  it("creates a tuning_run record on live run", async ({ skip }) => {
    if (!doltAvailable) skip();

    const result = await tune({ dryRun: false, hours: 1 });

    expect(result.status).toBe("completed");

    const rows = await query<any[]>(`SELECT * FROM tuning_run WHERE run_id = ?`, [result.run_id]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].completed_at).not.toBeNull();

    // Cleanup
    await getPool().query("DELETE FROM tuning_run WHERE run_id = ?", [result.run_id]);
  });
});

describe("tune (concurrent run guard)", () => {
  it("rejects a second live run while one is in progress", async ({ skip }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    const fakeRunId = "test-tune-concurrent-guard";

    // Simulate an in-progress run
    await pool.query(
      `INSERT INTO tuning_run (run_id, status, hours_window) VALUES (?, 'running', 1)`,
      [fakeRunId],
    );

    try {
      await expect(tune({ dryRun: false, hours: 1 })).rejects.toThrow(
        /Another tuning run is already in progress/,
      );
    } finally {
      await pool.query("DELETE FROM tuning_run WHERE run_id = ?", [fakeRunId]);
    }
  });

  it("allows dry run even when a live run is in progress", async ({ skip }) => {
    if (!doltAvailable) skip();

    const pool = getPool();
    const fakeRunId = "test-tune-concurrent-dryrun";

    await pool.query(
      `INSERT INTO tuning_run (run_id, status, hours_window) VALUES (?, 'running', 1)`,
      [fakeRunId],
    );

    try {
      const result = await tune({ dryRun: true, hours: 1 });
      expect(result.status).toBe("dry_run");
    } finally {
      await pool.query("DELETE FROM tuning_run WHERE run_id = ?", [fakeRunId]);
    }
  });
});

describe("recentTuningRuns", () => {
  it("returns recent runs in descending order", async ({ skip }) => {
    if (!doltAvailable) skip();

    const r1 = await tune({ dryRun: false, hours: 1 });
    const r2 = await tune({ dryRun: false, hours: 1 });

    const runs = await recentTuningRuns(5);
    expect(runs.length).toBeGreaterThanOrEqual(2);

    const idx1 = runs.findIndex((r) => r.run_id === r1.run_id);
    const idx2 = runs.findIndex((r) => r.run_id === r2.run_id);
    expect(idx2).toBeLessThan(idx1);

    // Cleanup
    const pool = getPool();
    await pool.query("DELETE FROM tuning_run WHERE run_id IN (?, ?)", [r1.run_id, r2.run_id]);
  });
});
