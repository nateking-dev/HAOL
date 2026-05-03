import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { runMigrations, sha256 } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../src/db/migrations",
);

let doltAvailable = false;

const EXPECTED_TABLES = [
  "agent_registry",
  "capability_taxonomy",
  "task_log",
  "execution_log",
  "routing_policy",
  "session_context",
  "handoff_summary",
  "tuning_run",
];

beforeAll(async () => {
  const config = loadConfig();
  try {
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }
    await query("SELECT 1");
    doltAvailable = true;
  } catch {
    console.warn("Dolt not available — skipping migration tests");
  }
});

afterAll(async () => {
  await destroy();
});

describe("migrations", () => {
  it("applies all migration files without error", async ({ skip }) => {
    if (!doltAvailable) skip();
    // First call either runs all 20 (fresh DB) or backfills tracking from
    // an existing populated DB and returns an empty list. Either way the
    // post-condition is "every file recorded in migrations_applied."
    await runMigrations();
    const rows = await query<{ filename: string }>(
      "SELECT filename FROM migrations_applied ORDER BY filename",
    );
    expect(rows.length).toBe(20);
    expect(rows[0].filename).toBe("001_create_agent_registry.sql");
    expect(rows[19].filename).toBe("020_fix_signal_value_nullable.sql");
  });

  it("is idempotent — second run does no work", async ({ skip }) => {
    if (!doltAvailable) skip();
    const ran = await runMigrations();
    expect(ran.length).toBe(0);
  });

  it("detects drift when an applied migration's SHA differs from disk", async ({ skip }) => {
    if (!doltAvailable) skip();
    const file = "020_fix_signal_value_nullable.sql";
    const onDisk = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const realSha = sha256(onDisk);
    const fakeSha = "0".repeat(64);
    try {
      await query("UPDATE migrations_applied SET sha256 = ? WHERE filename = ?", [fakeSha, file]);
      await expect(runMigrations()).rejects.toThrow(/drifted/);
    } finally {
      await query("UPDATE migrations_applied SET sha256 = ? WHERE filename = ?", [realSha, file]);
    }
  });

  it("backfills tracking when schema is populated but migrations_applied is empty", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();
    const sqlFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const expected = new Map<string, string>();
    for (const file of sqlFiles) {
      expected.set(file, sha256(await readFile(join(MIGRATIONS_DIR, file), "utf8")));
    }

    // Wipe tracking — simulates a DB that pre-dates this PR. agent_registry
    // (created by 001) still exists, so the runner should detect legacy
    // schema and backfill rather than re-running ALTERs.
    await query("DELETE FROM migrations_applied");

    const ran = await runMigrations();
    expect(ran.length).toBe(0);

    const rows = await query<{ filename: string; sha256: string }>(
      "SELECT filename, sha256 FROM migrations_applied ORDER BY filename",
    );
    expect(rows.length).toBe(sqlFiles.length);
    for (const row of rows) {
      expect(row.sha256).toBe(expected.get(row.filename));
    }
  });

  it("creates expected tables", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = 'haol' AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
    );
    const tableNames = rows.map((r: any) => r.TABLE_NAME);
    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }
  });

  it("capability_taxonomy has 9 seed rows", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("SELECT COUNT(*) AS cnt FROM capability_taxonomy");
    expect(rows[0].cnt).toBe(9);
  });

  it("agent_registry has correct columns", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE agent_registry");
    const columns = rows.map((r: any) => r.Field);
    expect(columns).toContain("agent_id");
    expect(columns).toContain("provider");
    expect(columns).toContain("capabilities");
    expect(columns).toContain("cost_per_1k_input");
    expect(columns).toContain("status");
    expect(columns).toContain("tier_ceiling");
  });

  it("task_log status column has correct enum values", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE task_log");
    const statusRow = rows.find((r: any) => r.Field === "status");
    expect(statusRow).toBeDefined();
    expect(statusRow.Type).toContain("QUEUED");
    expect(statusRow.Type).toContain("RECEIVED");
    expect(statusRow.Type).toContain("CLASSIFIED");
    expect(statusRow.Type).toContain("DISPATCHED");
    expect(statusRow.Type).toContain("COMPLETED");
    expect(statusRow.Type).toContain("FAILED");
  });

  it("migration 019 adds async-pipeline columns and index to task_log", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE task_log");
    const columns = rows.map((r: any) => r.Field);
    for (const col of [
      "prompt",
      "input_metadata",
      "input_constraints",
      "worker_started_at",
      "worker_finished_at",
      "worker_error",
      "response_content",
    ]) {
      expect(columns, `task_log column ${col}`).toContain(col);
    }
    const idx = await query<any>("SHOW INDEX FROM task_log WHERE Key_name = ?", [
      "idx_task_log_status_created",
    ]);
    expect(idx.length).toBeGreaterThanOrEqual(1);
  });

  it("routing_policy has correct columns", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE routing_policy");
    const columns = rows.map((r: any) => r.Field);
    expect(columns).toContain("policy_id");
    expect(columns).toContain("weight_capability");
    expect(columns).toContain("weight_cost");
    expect(columns).toContain("weight_latency");
    expect(columns).toContain("fallback_strategy");
    expect(columns).toContain("max_retries");
    expect(columns).toContain("active");
  });

  it("session_context has composite primary key", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE session_context");
    const pkRows = rows.filter((r: any) => r.Key === "PRI");
    const pkColumns = pkRows.map((r: any) => r.Field);
    expect(pkColumns).toContain("session_id");
    expect(pkColumns).toContain("key");
  });

  it("handoff_summary has composite primary key", async ({ skip }) => {
    if (!doltAvailable) skip();
    const rows = await query<any>("DESCRIBE handoff_summary");
    const pkRows = rows.filter((r: any) => r.Key === "PRI");
    const pkColumns = pkRows.map((r: any) => r.Field);
    expect(pkColumns).toContain("task_id");
    expect(pkColumns).toContain("from_agent_id");
  });

  it("migration 017 creates expected indexes", async ({ skip }) => {
    if (!doltAvailable) skip();
    const expectedIndexes = [
      { table: "execution_log", name: "idx_execution_log_task_id" },
      { table: "task_log", name: "idx_task_log_selected_agent_id" },
      { table: "task_log", name: "idx_task_log_created_at" },
      { table: "routing_log", name: "idx_routing_log_request_id" },
      { table: "routing_utterances", name: "idx_utterances_embedding_model" },
      { table: "execution_log", name: "idx_execution_log_created_at" },
    ];
    for (const { table, name } of expectedIndexes) {
      const rows = await query<any>(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
      expect(rows.length, `index ${name} on ${table}`).toBeGreaterThanOrEqual(1);
    }
  });
});
