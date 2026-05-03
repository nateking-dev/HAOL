import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool, getPool, destroy } from "./connection.js";
import { doltCommit } from "./dolt.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS migrations_applied (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    sha256 CHAR(64) NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  )
`;

interface AppliedRow {
  filename: string;
  sha256: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function loadAppliedRows(): Promise<Map<string, string>> {
  const pool = getPool();
  const [rows] = (await pool.query("SELECT filename, sha256 FROM migrations_applied")) as [
    AppliedRow[],
    unknown,
  ];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.filename, row.sha256);
  return map;
}

async function legacySchemaExists(): Promise<boolean> {
  const pool = getPool();
  // agent_registry is created by 001_create_agent_registry.sql — its presence
  // signals that this DB was already migrated before tracking was introduced.
  const [rows] = (await pool.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_registry' LIMIT 1`,
  )) as [unknown[], unknown];
  return rows.length > 0;
}

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const pool = getPool();

  await pool.query(TRACKING_DDL);

  const applied = await loadAppliedRows();

  // One-time backfill: if tracking is empty but the schema is already
  // populated, this DB pre-dates the tracking table. Stamp every current
  // file as applied so we don't re-run non-idempotent ALTERs (e.g. 011's
  // ADD COLUMN without IF NOT EXISTS) and trip on duplicate-column errors.
  if (applied.size === 0 && (await legacySchemaExists())) {
    console.log("[migrate] existing schema detected — backfilling migrations_applied");
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const hash = sha256(sql);
      await pool.query("INSERT INTO migrations_applied (filename, sha256) VALUES (?, ?)", [
        file,
        hash,
      ]);
    }
    return [];
  }

  const ran: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const hash = sha256(sql);
    const recordedHash = applied.get(file);

    if (recordedHash) {
      if (recordedHash !== hash) {
        throw new Error(
          `Migration ${file} has drifted: applied SHA ${recordedHash.slice(0, 12)}… ` +
            `does not match disk SHA ${hash.slice(0, 12)}…. ` +
            `Revert the file or write a new migration instead of editing applied SQL.`,
        );
      }
      continue;
    }

    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }

    await pool.query("INSERT INTO migrations_applied (filename, sha256) VALUES (?, ?)", [
      file,
      hash,
    ]);
    ran.push(file);
  }

  return ran;
}

// CLI entry point
async function main() {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }

  console.log("Running migrations...");
  const ran = await runMigrations();
  if (ran.length === 0) {
    console.log("  no new migrations to apply.");
  } else {
    for (const file of ran) {
      console.log("  applied: %s", file);
    }
  }

  try {
    await doltCommit({
      message: "migration: initial schema",
      author: "haol-migrate <haol@system>",
    });
    console.log("Dolt commit created.");
  } catch (err) {
    if ((err as Error).message?.includes("nothing to commit")) {
      console.log("No changes to commit (already up to date).");
    } else {
      throw err;
    }
  }

  await destroy();
}

// Only run main when executed directly (not imported)
const isMain = process.argv[1]?.includes("migrate");
if (isMain) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
