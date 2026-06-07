import * as taskLog from "../repositories/task-log.js";
import * as worker from "./task-worker.js";
import { purgeExpiredInputText } from "../cascade-router/reference-store.js";
import { pruneSessionBranches } from "../memory/branch-cleanup.js";
import type { RouterTaskInput } from "../types/router.js";
import { logger } from "../logging/logger.js";
import { runWithContext } from "../logging/context.js";

/**
 * Crash-recovery reaper for the async task pipeline.
 *
 *  - QUEUED rows are re-enqueued — they never started, so retrying is safe.
 *  - RECEIVED/CLASSIFIED/DISPATCHED rows older than the recovery threshold
 *    are marked FAILED. We deliberately do NOT retry these: an LLM call may
 *    have partially completed and been billed, and double-charging on a
 *    transient crash is worse than surfacing a clean failure to the caller.
 *  - On each sweep, prune session branches older than
 *    SESSION_BRANCH_RETENTION_DAYS. We deliberately do NOT delete the branch
 *    when reaping a stale row: the router's memory layer leaves the branch
 *    around on FAILED so its working set is available for forensics until
 *    retention expires.
 *
 * The recovery threshold is intentionally well above the longest tier-4
 * timeout (120s) — a healthy worker may legitimately hold a row in
 * DISPATCHED for two minutes. Default 10 min; tune via WORKER_RECOVERY_AGE_MS.
 */

const STUCK_REASON = "worker_crashed";

// How many QUEUED rows to pull per page when re-enqueuing at startup. Bounds
// peak memory (each row carries its LONGTEXT prompt) without making the sweep
// chatty. Override via WORKER_REQUEUE_PAGE_SIZE.
function queuedPageSize(): number {
  const raw = process.env.WORKER_REQUEUE_PAGE_SIZE;
  if (!raw) return 100;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

let timer: NodeJS.Timeout | null = null;

// Floor the recovery threshold at 5 min so a misconfigured value can't
// reap healthy in-flight T3/T4 tasks (tier-4 timeout is 120s; we need
// well above that plus reaper-interval slop to be safe).
const RECOVERY_AGE_FLOOR_MS = 300_000;

function recoveryAgeSeconds(): number {
  const raw = process.env.WORKER_RECOVERY_AGE_MS;
  if (!raw) return 600; // 10 minutes
  const ms = parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms < RECOVERY_AGE_FLOOR_MS) return 600;
  return Math.ceil(ms / 1000);
}

function reaperIntervalMs(): number {
  const raw = process.env.WORKER_REAPER_INTERVAL_MS;
  if (!raw) return 60_000;
  const ms = parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 1000 ? ms : 60_000;
}

// Default 7 days. We require >= 1 to prevent a misconfigured 0 from wiping
// in-flight session branches whose working sets have not yet been merged.
function sessionRetentionDays(): number {
  const raw = process.env.SESSION_BRANCH_RETENTION_DAYS;
  if (!raw) return 7;
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days < 1) return 7;
  return days;
}

// Retention window (days) before raw prompt / input_text are nulled (#79).
// Default 30. A value <= 0 disables the purge (opt out) — returned as null so
// the sweep skips it. An invalid/non-numeric value falls back to the default
// rather than silently disabling retention.
const PROMPT_RETENTION_DEFAULT_DAYS = 30;
function promptRetentionDays(): number | null {
  const raw = process.env.PROMPT_RETENTION_DAYS;
  if (!raw) return PROMPT_RETENTION_DEFAULT_DAYS;
  // Number() rather than parseInt() so partial-garbage like "0_days" or
  // "30days" becomes NaN and fails *safe* to the default. parseInt's
  // leading-digit coercion ("0_days" -> 0) would otherwise hit the disable
  // path and silently retain PII indefinitely — the opposite of what an
  // operator who fat-fingered the value intended. Warn on invalid input so
  // the misconfiguration is visible in logs rather than silently swallowed.
  const days = Number(raw.trim());
  if (!Number.isInteger(days)) {
    logger.warn("invalid PROMPT_RETENTION_DAYS; falling back to default", {
      value: raw,
      default_days: PROMPT_RETENTION_DEFAULT_DAYS,
    });
    return PROMPT_RETENTION_DEFAULT_DAYS;
  }
  if (days <= 0) return null; // explicit opt-out
  return days;
}

function reconstructInput(record: taskLog.TaskLogRecord): RouterTaskInput | null {
  if (!record.prompt) return null;
  // DB columns return null for absent JSON; the Zod schema requires
  // object | undefined, so coerce.
  const input: RouterTaskInput = { prompt: record.prompt };
  if (record.input_metadata) {
    input.metadata = record.input_metadata as RouterTaskInput["metadata"];
  }
  if (record.input_constraints) {
    input.constraints = record.input_constraints as RouterTaskInput["constraints"];
  }
  if (record.expected_format) {
    input.expected_format = record.expected_format as RouterTaskInput["expected_format"];
  }
  return input;
}

export interface ReaperResult {
  reEnqueued: number;
  duplicates: number;
  failed: number;
  branchesPruned: number;
  promptsPurged: number;
}

export async function runReaperOnce(): Promise<ReaperResult> {
  return runWithContext({ component: "reaper" }, () => runReaperOnceInner());
}

async function runReaperOnceInner(): Promise<ReaperResult> {
  const ageSec = recoveryAgeSeconds();
  let reEnqueued = 0;
  // Rows the worker refused as already queued/in-flight (the reaper raced a
  // live worker that re-queued the same row). Counted separately so they
  // don't inflate reEnqueued — they represent no new work.
  let duplicates = 0;
  let failed = 0;
  let branchesPruned = 0;
  let promptsPurged = 0;

  // 1. Re-enqueue any QUEUED row regardless of age — the in-memory queue is
  // empty at startup, so anything that survived a restart needs a kick. At
  // steady state during periodic sweeps, claimQueued() will harmlessly
  // refuse duplicates.
  //
  // Drained page-by-page (keyset on created_at, task_id) rather than loading
  // every QUEUED row — including its LONGTEXT prompt — at once: a boot-time
  // backlog of large prompts would otherwise risk OOM. We stop early once the
  // worker can't accept more, so we don't pull prompts the worker would just
  // reject (its in-memory queue cap converts overflow into queue_full anyway).
  const pageSize = queuedPageSize();
  let cursor: taskLog.QueuedCursor | undefined;
  let draining = true;
  while (draining) {
    let page: taskLog.TaskLogRecord[] = [];
    try {
      page = await taskLog.findQueuedPage(pageSize, cursor);
    } catch (err) {
      logger.warn("findQueuedPage failed", { error: (err as Error).message });
      break;
    }
    if (page.length === 0) break;

    for (const row of page) {
      const input = reconstructInput(row);
      if (!input) {
        // Row predates the async pipeline (no stashed prompt); fail it.
        try {
          await taskLog.recordWorkerError(row.task_id, "queued_without_prompt");
          failed++;
        } catch {
          // best-effort
        }
        continue;
      }
      if (!worker.canAccept()) {
        // Worker queue is full/stopping — leave the rest QUEUED for the next
        // sweep instead of loading more prompts it can't take.
        draining = false;
        break;
      }
      // canAccept() is only a pre-flight hint; enqueue()'s return is the
      // source of truth. Branch on it so a "duplicate" (we raced a live
      // worker that already re-queued this row) doesn't inflate reEnqueued,
      // and a queue that filled in the canAccept→enqueue gap stops the drain
      // rather than having the row silently dropped from this sweep.
      const outcome = worker.enqueue(row.task_id, input);
      if (outcome === "ok") {
        reEnqueued++;
      } else if (outcome === "duplicate") {
        duplicates++;
      } else {
        // "queue_full" | "stopping" — the worker can't take more right now.
        draining = false;
        break;
      }
    }

    // Stop on a short page (queue drained) or an early stop (worker full).
    // Only advance the cursor when we'll actually fetch another page, so we
    // never leave a cursor pointing past unprocessed rows.
    if (!draining || page.length < pageSize) break;
    const last = page[page.length - 1];
    cursor = { created_at: last.created_at, task_id: last.task_id };
  }

  // 2. Mark stale in-flight rows FAILED. findStale returns just the
  // task_ids — no need to pull full rows (incl. LONGTEXT prompt) since
  // the reaper only needs to UPDATE and delete the session branch.
  let staleIds: string[] = [];
  try {
    staleIds = await taskLog.findStale(ageSec);
  } catch (err) {
    logger.warn("findStale failed", { error: (err as Error).message });
  }
  for (const taskId of staleIds) {
    try {
      await taskLog.recordWorkerError(taskId, STUCK_REASON);
      // Intentionally do NOT delete session/${taskId}: the router's memory
      // layer keeps the branch around on FAILED so the working set is
      // available for forensics. pruneSessionBranches reclaims it once the
      // retention window expires.
      failed++;
    } catch (err) {
      logger.warn("failed to mark task FAILED", {
        task_id: taskId,
        error: (err as Error).message,
      });
    }
  }

  // 3. Prune aged-out session branches. Best-effort — a Dolt issue here
  // must not stop the reaper from re-enqueuing tasks on the next sweep.
  try {
    const pruned = await pruneSessionBranches(sessionRetentionDays());
    branchesPruned = pruned.length;
  } catch (err) {
    logger.warn("pruneSessionBranches failed", { error: (err as Error).message });
  }

  // 4. PII retention: null raw prompt / input_text past the retention window
  // (#79). Best-effort and independent — a failure on one table must not stop
  // the other or the rest of the sweep. Skipped entirely when disabled (<= 0).
  const retentionDays = promptRetentionDays();
  if (retentionDays !== null) {
    try {
      promptsPurged += await taskLog.purgeExpiredPrompts(retentionDays);
    } catch (err) {
      logger.warn("purgeExpiredPrompts failed", { error: (err as Error).message });
    }
    try {
      promptsPurged += await purgeExpiredInputText(retentionDays);
    } catch (err) {
      logger.warn("purgeExpiredInputText failed", { error: (err as Error).message });
    }
  }

  if (reEnqueued > 0 || duplicates > 0 || failed > 0 || branchesPruned > 0 || promptsPurged > 0) {
    logger.info("reaper sweep summary", {
      re_enqueued: reEnqueued,
      duplicates,
      failed,
      branches_pruned: branchesPruned,
      prompts_purged: promptsPurged,
    });
  }
  return { reEnqueued, duplicates, failed, branchesPruned, promptsPurged };
}

export function startReaper(): void {
  if (timer) return;
  timer = setInterval(() => {
    runReaperOnce().catch((err) => {
      logger.warn("sweep failed", {
        component: "reaper",
        error: (err as Error).message,
      });
    });
  }, reaperIntervalMs());
  timer.unref();
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
