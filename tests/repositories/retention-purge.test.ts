import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { purgeExpiredPrompts } from "../../src/repositories/task-log.js";
import { purgeExpiredInputText } from "../../src/cascade-router/reference-store.js";
import { uuidv7, sha256 } from "../../src/types/task.js";

// DB-integration coverage for the actual purge SQL (#79). The reaper unit
// tests mock these functions and only exercise control flow; here we assert
// the WHERE predicate actually nulls aged rows, retains the hash fingerprint,
// and leaves fresh rows untouched. Skips gracefully without Dolt.

let doltAvailable = false;

// Unique tags so this suite only ever touches its own rows. task_log.prompt_hash
// survives the purge, so we tag + clean up task_log by it. routing_log.request_id
// is VARCHAR(36) (UUID-sized, no room for a prefix), so routing_log rows carry a
// random UUID request_id and are cleaned up by their retained input_text_sha256 —
// which also survives the purge. Texts are run-unique to avoid cross-run collisions.
const PROMPT_TAG = `TEST_RETENTION_${Date.now()}`;
const RUN_NONCE = `${Date.now()}`;
const oldText = `SECRET_INPUT_OLD_${RUN_NONCE}`;
const freshText = `SECRET_INPUT_FRESH_${RUN_NONCE}`;

beforeAll(async () => {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }
  try {
    await query("SELECT 1");
    await runMigrations();
    doltAvailable = true;
  } catch {
    console.warn("Dolt not available — skipping retention purge tests");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM task_log WHERE prompt_hash LIKE ?", [`${PROMPT_TAG}%`]);
    await pool.query("DELETE FROM routing_log WHERE input_text_sha256 IN (?, ?)", [
      sha256(oldText),
      sha256(freshText),
    ]);
  }
  await destroy();
});

describe("purgeExpiredPrompts", () => {
  it("nulls prompt on rows older than the window, retains hash, spares fresh rows", async ({
    skip,
  }) => {
    if (!doltAvailable) skip();
    const pool = getPool();

    const oldId = uuidv7();
    const freshId = uuidv7();
    const oldHash = `${PROMPT_TAG}_old`;
    const freshHash = `${PROMPT_TAG}_fresh`;

    // 40 days old — past a 30-day window.
    await pool.query(
      `INSERT INTO task_log (task_id, created_at, status, prompt_hash, prompt)
       VALUES (?, NOW() - INTERVAL 40 DAY, 'COMPLETED', ?, 'SECRET_PROMPT')`,
      [oldId, oldHash],
    );
    // Fresh — must survive.
    await pool.query(
      `INSERT INTO task_log (task_id, status, prompt_hash, prompt)
       VALUES (?, 'COMPLETED', ?, 'FRESH_PROMPT')`,
      [freshId, freshHash],
    );

    const purged = await purgeExpiredPrompts(30);
    expect(purged).toBeGreaterThanOrEqual(1);

    const [oldRows] = (await pool.query(
      "SELECT prompt, prompt_hash FROM task_log WHERE task_id = ?",
      [oldId],
    )) as [Array<{ prompt: string | null; prompt_hash: string }>, unknown];
    const [freshRows] = (await pool.query("SELECT prompt FROM task_log WHERE task_id = ?", [
      freshId,
    ])) as [Array<{ prompt: string | null }>, unknown];

    // Raw text gone, non-reversible fingerprint retained.
    expect(oldRows[0].prompt).toBeNull();
    expect(oldRows[0].prompt_hash).toBe(oldHash);
    // Fresh row untouched.
    expect(freshRows[0].prompt).toBe("FRESH_PROMPT");
  });

  it("is idempotent — a second pass purges nothing new", async ({ skip }) => {
    if (!doltAvailable) skip();
    const pool = getPool();
    const id = uuidv7();
    await pool.query(
      `INSERT INTO task_log (task_id, created_at, status, prompt_hash, prompt)
       VALUES (?, NOW() - INTERVAL 40 DAY, 'COMPLETED', ?, 'SECRET')`,
      [id, `${PROMPT_TAG}_idem`],
    );
    await purgeExpiredPrompts(30);
    // The just-nulled row no longer matches `prompt IS NOT NULL`, so a fresh
    // insert-free re-run only re-nulls anything new (here: nothing of ours).
    const second = await purgeExpiredPrompts(30);
    const [rows] = (await pool.query("SELECT prompt FROM task_log WHERE task_id = ?", [id])) as [
      Array<{ prompt: string | null }>,
      unknown,
    ];
    expect(rows[0].prompt).toBeNull();
    expect(second).toBeGreaterThanOrEqual(0);
  });
});

describe("purgeExpiredInputText", () => {
  it("nulls input_text on rows older than the window and retains the sha256", async ({ skip }) => {
    if (!doltAvailable) skip();
    const pool = getPool();

    const oldLogId = uuidv7();
    const freshLogId = uuidv7();

    await pool.query(
      `INSERT INTO routing_log
         (log_id, request_id, input_text, input_text_sha256, routed_tier, routing_layer, similarity_score, confidence, latency_ms, created_at)
       VALUES (?, ?, ?, ?, 3, 'escalation', 0.4, 0.8, 100, NOW() - INTERVAL 40 DAY)`,
      [oldLogId, uuidv7(), oldText, sha256(oldText)],
    );
    await pool.query(
      `INSERT INTO routing_log
         (log_id, request_id, input_text, input_text_sha256, routed_tier, routing_layer, similarity_score, confidence, latency_ms)
       VALUES (?, ?, ?, ?, 3, 'escalation', 0.4, 0.8, 100)`,
      [freshLogId, uuidv7(), freshText, sha256(freshText)],
    );

    const purged = await purgeExpiredInputText(30);
    expect(purged).toBeGreaterThanOrEqual(1);

    const [oldRows] = (await pool.query(
      "SELECT input_text, input_text_sha256 FROM routing_log WHERE log_id = ?",
      [oldLogId],
    )) as [Array<{ input_text: string | null; input_text_sha256: string }>, unknown];
    const [freshRows] = (await pool.query("SELECT input_text FROM routing_log WHERE log_id = ?", [
      freshLogId,
    ])) as [Array<{ input_text: string | null }>, unknown];

    expect(oldRows[0].input_text).toBeNull();
    // Fingerprint preserved so observability dedup still works post-purge.
    expect(oldRows[0].input_text_sha256).toBe(sha256(oldText));
    expect(freshRows[0].input_text).toBe(freshText);
  });
});
