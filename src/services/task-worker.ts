import { routeTask } from "../router/router.js";
import * as taskLog from "../repositories/task-log.js";
import type { RouterTaskInput } from "../types/router.js";

/**
 * In-process background worker for the async POST /tasks pipeline.
 *
 * Design:
 *  - The HTTP handler inserts a row in task_log with status QUEUED, then calls
 *    enqueue(). The worker drains an in-memory queue and runs routeTask() on
 *    each job up to WORKER_CONCURRENCY in parallel.
 *  - claimQueued() conditionally transitions QUEUED → RECEIVED; if a duplicate
 *    enqueue arrives (e.g. the reaper races a live worker), the second claim
 *    fails harmlessly and the job is dropped.
 *  - On crash, anything still in QUEUED/RECEIVED/CLASSIFIED/DISPATCHED is
 *    handled by the reaper at next startup (see startReaper). The worker
 *    itself only owns the in-memory queue.
 */

interface Job {
  taskId: string;
  input: RouterTaskInput;
}

const queue: Job[] = [];
let inflight = 0;
let started = false;
let stopping = false;
let drainResolver: (() => void) | null = null;

function workerConcurrency(): number {
  const raw = process.env.WORKER_CONCURRENCY;
  if (!raw) return 4;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function enqueue(taskId: string, input: RouterTaskInput): void {
  queue.push({ taskId, input });
  // Kick the loop on next tick so callers (HTTP handler) can return first.
  setImmediate(pump);
}

function pump(): void {
  if (stopping) {
    maybeResolveDrain();
    return;
  }
  const max = workerConcurrency();
  while (inflight < max && queue.length > 0) {
    const job = queue.shift()!;
    inflight++;
    runJob(job).finally(() => {
      inflight--;
      if (queue.length > 0) {
        setImmediate(pump);
      } else {
        maybeResolveDrain();
      }
    });
  }
}

async function runJob(job: Job): Promise<void> {
  // Claim the row — if another worker (or the reaper) already moved it past
  // QUEUED, drop this duplicate enqueue silently.
  let claimed = false;
  try {
    claimed = await taskLog.claimQueued(job.taskId);
  } catch (err) {
    console.warn(
      "[task-worker] claimQueued failed for %s: %s",
      job.taskId,
      (err as Error).message,
    );
    return;
  }
  if (!claimed) return;

  try {
    // routeTask sets status to COMPLETED/FAILED and stamps worker_finished_at
    // atomically (see taskLog.updateStatus for the terminal-state case).
    await routeTask(job.input, { taskId: job.taskId });
  } catch (err) {
    // routeTask handles its own failures and writes FAILED to task_log, but
    // any unhandled throw (DB outage, etc.) lands here. Best-effort mark the
    // row FAILED so callers polling GET /tasks/:id see a terminal state.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[task-worker] uncaught error for %s: %s", job.taskId, message);
    try {
      await taskLog.recordWorkerError(job.taskId, message);
    } catch (writeErr) {
      console.error(
        "[task-worker] failed to record worker_error for %s: %s",
        job.taskId,
        (writeErr as Error).message,
      );
    }
  }
}

function maybeResolveDrain(): void {
  if (stopping && inflight === 0 && queue.length === 0 && drainResolver) {
    drainResolver();
    drainResolver = null;
  }
}

export function start(): void {
  if (started) return;
  started = true;
  stopping = false;
}

/**
 * Drain any in-flight work and refuse new enqueues. Called on SIGTERM by the
 * server entry point. The grace period bounds how long we'll wait for
 * in-flight LLM calls to finish before the process exits anyway.
 */
export async function stop(graceMs = 30_000): Promise<void> {
  if (!started) return;
  stopping = true;
  if (inflight === 0 && queue.length === 0) return;

  await new Promise<void>((resolve) => {
    drainResolver = resolve;
    setTimeout(() => {
      if (drainResolver) {
        console.warn(
          "[task-worker] grace period exceeded with %d in-flight jobs",
          inflight,
        );
        const r = drainResolver;
        drainResolver = null;
        r();
      }
    }, graceMs).unref();
  });
}

/** Test/observability hook. */
export function inspect(): { queued: number; inflight: number } {
  return { queued: queue.length, inflight };
}

/** Test reset — clears in-memory state without touching the DB. */
export function _resetForTests(): void {
  queue.length = 0;
  inflight = 0;
  started = false;
  stopping = false;
  drainResolver = null;
}
