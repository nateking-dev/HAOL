import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

let doltAvailable = false;

const EXPECTED_TABLES = [
  "agent_registry",
  "capability_taxonomy",
  "task_log",
  "execution_log",
  "routing_policy",
  "session_context",
  "handoff_summary",
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
    const applied = await runMigrations();
    expect(applied.length).toBe(15);
    expect(applied[0]).toBe("001_create_agent_registry.sql");
    expect(applied[14]).toBe("015_fix_routing_rule_regex_patterns.sql");
  });

  it("is idempotent — running twice produces no errors", async ({ skip }) => {
    if (!doltAvailable) skip();
    // Second run should not throw
    const applied = await runMigrations();
    expect(applied.length).toBe(15);
  });

  it("creates all 7 tables", async ({ skip }) => {
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
    expect(statusRow.Type).toContain("RECEIVED");
    expect(statusRow.Type).toContain("CLASSIFIED");
    expect(statusRow.Type).toContain("DISPATCHED");
    expect(statusRow.Type).toContain("COMPLETED");
    expect(statusRow.Type).toContain("FAILED");
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
});
