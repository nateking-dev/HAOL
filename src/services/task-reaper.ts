import * as taskLog from "../repositories/task-log.js";
import * as worker from "./task-worker.js";
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

export async function runReaperOnce(): Promise<{
  reEnqueued: number;
  failed: number;
  branchesPruned: number;
}> {
  return runWithContext({ component: "reaper" }, () => runReaperOnceInner());
}

async function runReaperOnceInner(): Promise<{
  reEnqueued: number;
  failed: number;
  branchesPruned: number;
}> {
  const ageSec = recoveryAgeSeconds();
  let reEnqueued = 0;
  let failed = 0;
  let branchesPruned = 0;

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
      worker.enqueue(row.task_id, input);
      reEnqueued++;
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

  if (reEnqueued > 0 || failed > 0 || branchesPruned > 0) {
    logger.info("reaper sweep summary", {
      re_enqueued: reEnqueued,
      failed,
      branches_pruned: branchesPruned,
    });
  }
  return { reEnqueued, failed, branchesPruned };
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
