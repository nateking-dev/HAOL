/**
 * HAOL Demo Setup — One-shot script to prepare the system for a live demo.
 *
 * Steps:
 *  1. Verify Dolt is reachable
 *  2. Run migrations
 *  3. Seed data (agents, tiers, rules, utterances, config)
 *  4. Compute embeddings for reference utterances
 *  5. Health-check providers
 *  6. Report readiness
 *
 * Usage: npm run demo:setup
 */

import { loadConfig } from "../src/config.js";
import { createPool, getPool, query, destroy } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import type { RowDataPacket } from "mysql2/promise";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

function ok(msg: string) {
  console.log(`  ${GREEN}\u2713${RESET} ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${YELLOW}\u26a0${RESET} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${RED}\u2717${RESET} ${msg}`);
}
function heading(msg: string) {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

async function main() {
  console.log(`${BOLD}HAOL Demo Setup${RESET}\n`);

  const config = loadConfig();

  // 1. Dolt connectivity
  heading("1. Database");
  try {
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }
    const rows = await query<(RowDataPacket & { v: string })[]>("SELECT VERSION() AS v");
    ok(`Connected to Dolt (${rows[0]?.v || "unknown version"})`);
  } catch (err) {
    fail(`Cannot connect to Dolt: ${(err as Error).message}`);
    console.log("\n  Make sure Dolt is running:");
    console.log("    dolt sql-server -H 0.0.0.0 -P 3306 -u root\n");
    process.exit(1);
  }

  // 2. Migrations
  heading("2. Migrations");
  try {
    const applied = await runMigrations();
    if (applied.length === 0) {
      ok("All migrations already applied");
    } else {
      ok(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
    }
  } catch (err) {
    fail(`Migration failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // 3. Seed data
  heading("3. Seed data");
  try {
    // Run seed as a child process so its standalone pool management doesn't conflict
    const { execSync } = await import("child_process");
    execSync("npx tsx src/db/seed.ts", { cwd: process.cwd(), stdio: "inherit" });
    ok("Seed data inserted");
  } catch {
    // Seed uses INSERT IGNORE, so partial re-runs are safe — a non-zero exit
    // here usually means the data already exists.
    warn("Seed exited with an error (INSERT IGNORE means re-runs are usually fine)");
  }

  // 4. Embeddings
  heading("4. Embeddings");
  try {
    // Re-establish pool after seed may have destroyed it
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }

    const pending = await query<(RowDataPacket & { cnt: number })[]>(
      "SELECT COUNT(*) AS cnt FROM routing_utterances WHERE embedding_model = 'pending'",
    );
    const count = Number(pending[0]?.cnt ?? 0);

    if (count === 0) {
      ok("All utterance embeddings already computed");
    } else {
      ok(`${count} utterances need embeddings — running seed:embeddings...`);
      const { execSync } = await import("child_process");
      execSync("npx tsx src/cascade-router/seed-embeddings.ts", {
        cwd: process.cwd(),
        stdio: "inherit",
      });
      ok("Embeddings computed");
    }
  } catch (err) {
    fail(`Embedding failed: ${(err as Error).message}`);
    console.log("  Make sure OPENAI_API_KEY is set in .env\n");
  }

  // 5. Provider health checks
  heading("5. Providers");

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const p = new AnthropicProvider("claude-haiku-4-5-20251001");
      const healthy = await p.healthCheck();
      healthy ? ok("Anthropic: reachable") : warn("Anthropic: health check returned false");
    } catch (err) {
      warn(`Anthropic: ${(err as Error).message}`);
    }
  } else {
    warn("Anthropic: ANTHROPIC_API_KEY not set");
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const p = new OpenAIProvider("gpt-4o-mini");
      const healthy = await p.healthCheck();
      healthy ? ok("OpenAI: reachable") : warn("OpenAI: health check returned false");
    } catch (err) {
      warn(`OpenAI: ${(err as Error).message}`);
    }
  } else {
    warn("OpenAI: OPENAI_API_KEY not set");
  }

  // Local (Ollama)
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    res.ok ? ok("Ollama: reachable") : warn("Ollama: responded with " + res.status);
  } catch {
    warn("Ollama: not reachable (local-llama agent will be unavailable)");
  }

  // 6. Summary
  heading("6. Ready");

  if (process.env.HAOL_API_KEY) {
    warn("HAOL_API_KEY is set — the demo UI calls /tasks and /observability without auth headers.");
    warn("Unset HAOL_API_KEY for the demo, or requests will return 401.");
  }

  console.log(`
  Start the server:  ${BOLD}npm run dev${RESET}
  Open the demo:     ${BOLD}http://localhost:3000/demo/${RESET}
`);

  await destroy();
}

main().catch((err) => {
  console.error("\nDemo setup failed:", err);
  process.exit(1);
});
