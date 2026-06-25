import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { runMigrations, splitStatements } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

let doltAvailable = false;

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
    console.warn("Dolt not available — skipping idempotency tests");
  }
});

afterAll(async () => {
  await destroy();
});

describe("splitStatements", () => {
  it("splits naive multi-statement DDL", () => {
    const sql = "ALTER TABLE t ADD COLUMN a INT;\nALTER TABLE t ADD COLUMN b INT;";
    expect(splitStatements(sql)).toEqual([
      "ALTER TABLE t ADD COLUMN a INT",
      "ALTER TABLE t ADD COLUMN b INT",
    ]);
  });

  it("does not split on a semicolon inside a single-quoted literal", () => {
    const sql = "INSERT INTO t (s) VALUES ('a;b;c'); SELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t (s) VALUES ('a;b;c')", "SELECT 1"]);
  });

  it("does not split on a semicolon inside a double-quoted literal", () => {
    const sql = `INSERT INTO t (s) VALUES ("x;y"); SELECT 2;`;
    expect(splitStatements(sql)).toEqual([`INSERT INTO t (s) VALUES ("x;y")`, "SELECT 2"]);
  });

  it("does not split on a semicolon inside a backtick identifier", () => {
    const sql = "SELECT `weird;col` FROM t; SELECT 3;";
    expect(splitStatements(sql)).toEqual(["SELECT `weird;col` FROM t", "SELECT 3"]);
  });

  it("does not split on a semicolon inside a -- line comment", () => {
    const sql = "SELECT 1; -- comment ; with semicolon\nSELECT 2;";
    expect(splitStatements(sql)).toEqual(["SELECT 1", "-- comment ; with semicolon\nSELECT 2"]);
  });

  it("does not split on a semicolon inside a /* */ block comment", () => {
    const sql = "SELECT 1; /* block ; ; comment */ SELECT 2;";
    expect(splitStatements(sql)).toEqual(["SELECT 1", "/* block ; ; comment */ SELECT 2"]);
  });

  it("handles SQL '' escape inside a single-quoted literal", () => {
    const sql = "INSERT INTO t (s) VALUES ('it''s; fine'); SELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t (s) VALUES ('it''s; fine')", "SELECT 1"]);
  });

  it("ignores trailing whitespace and an empty terminator", () => {
    const sql = "SELECT 1;\n\n;\n";
    expect(splitStatements(sql)).toEqual(["SELECT 1"]);
  });
});

describe("migrate.ts idempotency on re-run", () => {
  it("recovers when an applied migration's column already exists but tracking row is missing", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();

    // Simulate a crash mid-migration: untrack 011 so the runner treats it
    // as new, and verify it succeeds even though the column already exists
    // (because migration 011 was actually applied previously).
    const file = "011_add_routing_confidence_to_task_log.sql";

    // Stash the recorded hash so we can restore it cleanly.
    const before = await query<{ sha256: string }>(
      "SELECT sha256 FROM migrations_applied WHERE filename = ?",
      [file],
    );
    const recordedHash = before[0]?.sha256;
    expect(recordedHash, `${file} should already be tracked from prior runs`).toBeTruthy();

    try {
      await query("DELETE FROM migrations_applied WHERE filename = ?", [file]);

      // Re-run. Without the recovery catch this would throw
      // ER_DUP_FIELDNAME (1060) on `ALTER TABLE task_log ADD COLUMN
      // routing_confidence ...`. With the catch, both statements are
      // skipped with a warning and the tracking row is re-inserted.
      const ran = await runMigrations();
      expect(ran).toContain(file);

      const after = await query<{ filename: string }>(
        "SELECT filename FROM migrations_applied WHERE filename = ?",
        [file],
      );
      expect(after.length).toBe(1);
    } finally {
      // Re-store original tracking row exactly so other tests aren't perturbed.
      await query(
        "INSERT INTO migrations_applied (filename, sha256) VALUES (?, ?) " +
          "ON DUPLICATE KEY UPDATE sha256 = VALUES(sha256)",
        [file, recordedHash],
      );
    }
  });

  it("auto-rehashes a tolerated-drift SHA on the next run", async ({ skip }) => {
    if (!doltAvailable) skip();

    // 017 was edited to add `IF NOT EXISTS` to its CREATE INDEX statements.
    // Simulate an operator on the pre-edit SHA: the runner should detect
    // the tolerated drift, update the tracking row, and continue.
    const file = "017_add_missing_indexes.sql";
    const oldSha = "873803b5e9adc248f51fae4d4fb2e0b98a625a966040178fb3e3fd5eff40d8cd";

    const before = await query<{ sha256: string }>(
      "SELECT sha256 FROM migrations_applied WHERE filename = ?",
      [file],
    );
    const currentHash = before[0]?.sha256;
    expect(currentHash).toBeTruthy();

    try {
      await query("UPDATE migrations_applied SET sha256 = ? WHERE filename = ?", [oldSha, file]);

      const ran = await runMigrations();
      expect(ran, `${file} should NOT have re-run — it should be a tolerated rehash`).not.toContain(
        file,
      );

      const after = await query<{ sha256: string }>(
        "SELECT sha256 FROM migrations_applied WHERE filename = ?",
        [file],
      );
      expect(after[0].sha256).toBe(currentHash);
    } finally {
      await query("UPDATE migrations_applied SET sha256 = ? WHERE filename = ?", [
        currentHash,
        file,
      ]);
    }
  });

  it("CREATE INDEX IF NOT EXISTS in 019 is no-op on re-run (verified by no-error)", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();
    // The post-edit 019 uses CREATE INDEX IF NOT EXISTS; running it
    // directly against the already-populated schema must succeed.
    await query(
      "CREATE INDEX IF NOT EXISTS idx_task_log_status_created ON task_log (status, created_at)",
    );
  });
});
