import * as taskLog from "../repositories/task-log.js";
import * as worker from "./task-worker.js";
import { doltDeleteBranch } from "../db/dolt.js";
import type { RouterTaskInput } from "../types/router.js";

/**
 * Crash-recovery reaper for the async task pipeline.
 *
 *  - QUEUED rows are re-enqueued — they never started, so retrying is safe.
 *  - RECEIVED/CLASSIFIED/DISPATCHED rows older than the recovery threshold
 *    are marked FAILED. We deliberately do NOT retry these: an LLM call may
 *    have partially completed and been billed, and double-charging on a
 *    transient crash is worse than surfacing a clean failure to the caller.
 *  - On reap-to-FAILED, best-effort delete the per-task Dolt session branch
 *    so it doesn't accumulate on disk.
 *
 * The recovery threshold is intentionally well above the longest tier-4
 * timeout (120s) — a healthy worker may legitimately hold a row in
 * DISPATCHED for two minutes. Default 10 min; tune via WORKER_RECOVERY_AGE_MS.
 */

const STUCK_REASON = "worker_crashed";

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

async function deleteSessionBranchSafely(taskId: string): Promise<void> {
  try {
    await doltDeleteBranch(`session/${taskId}`);
  } catch {
    // Branch may not exist (task crashed before memory step) or may already
    // have been merged. Either way, nothing to recover.
  }
}

export async function runReaperOnce(): Promise<{
  reEnqueued: number;
  failed: number;
}> {
  const ageSec = recoveryAgeSeconds();
  let reEnqueued = 0;
  let failed = 0;

  // 1. Re-enqueue any QUEUED row regardless of age — the in-memory queue is
  // empty at startup, so anything that survived a restart needs a kick. At
  // steady state during periodic sweeps, claimQueued() will harmlessly
  // refuse duplicates.
  let queued: taskLog.TaskLogRecord[] = [];
  try {
    queued = await taskLog.findQueued();
  } catch (err) {
    console.warn("[reaper] findQueued failed: %s", (err as Error).message);
  }
  for (const row of queued) {
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
    worker.enqueue(row.task_id, input);
    reEnqueued++;
  }

  // 2. Mark stale in-flight rows FAILED. Filter to states that imply a
  // worker had picked the row up (skip QUEUED — handled above).
  let stale: taskLog.TaskLogRecord[] = [];
  try {
    stale = await taskLog.findStale(ageSec);
  } catch (err) {
    console.warn("[reaper] findStale failed: %s", (err as Error).message);
  }
  for (const row of stale) {
    if (row.status === "QUEUED") continue;
    try {
      await taskLog.recordWorkerError(row.task_id, STUCK_REASON);
      await deleteSessionBranchSafely(row.task_id);
      failed++;
    } catch (err) {
      console.warn("[reaper] failed to mark %s FAILED: %s", row.task_id, (err as Error).message);
    }
  }

  if (reEnqueued > 0 || failed > 0) {
    console.log("[reaper] re-enqueued=%d failed=%d", reEnqueued, failed);
  }
  return { reEnqueued, failed };
}

export function startReaper(): void {
  if (timer) return;
  timer = setInterval(() => {
    runReaperOnce().catch((err) => {
      console.warn("[reaper] sweep failed: %s", (err as Error).message);
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
