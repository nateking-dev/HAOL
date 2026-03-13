import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool, getPool, destroy } from "./connection.js";
import { doltCommit } from "./dolt.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const pool = getPool();
  const applied: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }
    applied.push(file);
  }

  return applied;
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
  const applied = await runMigrations();
  for (const file of applied) {
    console.log("  applied: %s", file);
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
