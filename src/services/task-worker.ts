import { routeTask } from "../router/router.js";
import * as taskLog from "../repositories/task-log.js";
import type { RouterTaskInput } from "../types/router.js";
import { logger } from "../logging/logger.js";
import { runWithContext } from "../logging/context.js";

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
  // Captured at enqueue time from the HTTP request that intook this task.
  // Lets the worker correlate post-202 logs (which run after the request
  // already returned) back to the originating request. Reaper-driven
  // re-enqueues have no request_id and pass undefined.
  requestId?: string;
}

const queue: Job[] = [];
// Tracks task IDs that are queued or in-flight in *this* process. The DB
// claimQueued gate is the cross-process source of truth (it protects against
// the reaper racing a live worker), but in-process duplicates need to be
// caught here — we cannot rely on Dolt's isolation to serialize two near-
// simultaneous UPDATE...WHERE status='QUEUED' statements on the same row.
const tracked = new Set<string>();
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

function maxQueueDepth(): number {
  const raw = process.env.WORKER_MAX_QUEUE_DEPTH;
  if (!raw) return 1000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

export type EnqueueResult = "ok" | "stopping" | "duplicate" | "queue_full";

export function enqueue(taskId: string, input: RouterTaskInput, requestId?: string): EnqueueResult {
  // Reject during shutdown: pump() bails when stopping=true, so a late
  // enqueue would sit in queue forever and prevent maybeResolveDrain() from
  // firing — stop() would then hang until its grace-period timeout. Server
  // shutdown order normally prevents this, but a concurrent reaper sweep
  // can still call enqueue() after stop() begins.
  if (stopping) return "stopping";
  if (tracked.has(taskId)) return "duplicate"; // already queued or running
  // Cap the in-memory queue so a sustained intake burst can't OOM the
  // process. The HTTP handler converts queue_full into 429 so callers get
  // an actionable signal instead of accumulating silently. Long-term the
  // Dolt-backed poll queue will replace this; the cap is the defense in
  // the meantime.
  if (queue.length >= maxQueueDepth()) return "queue_full";
  tracked.add(taskId);
  queue.push({ taskId, input, requestId });
  // Kick the loop on next tick so callers (HTTP handler) can return first.
  setImmediate(pump);
  return "ok";
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
    // runJob is async, so a synchronous throw in its body (e.g. from
    // runWithContext) becomes a rejected promise — the .finally() cleanup
    // (inflight--, tracked.delete) still runs, and the task ID never gets
    // stranded in `tracked`. runJobInner already catches its own errors, so
    // the .catch() here is defense-in-depth: it keeps a future regression
    // that lets runJob reject from surfacing as an unhandled rejection (the
    // re-raise that .finally() would otherwise propagate).
    runJob(job)
      .finally(() => {
        inflight--;
        tracked.delete(job.taskId);
        if (queue.length > 0) {
          setImmediate(pump);
        } else {
          maybeResolveDrain();
        }
      })
      .catch((err) => {
        logger.error("unexpected rejection from runJob", {
          task_id: job.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

async function runJob(job: Job): Promise<void> {
  // Bind task_id (and request_id, when known) into AsyncLocalStorage for the
  // duration of this job so every downstream log line carries them.
  return runWithContext(
    {
      component: "task-worker",
      task_id: job.taskId,
      ...(job.requestId ? { request_id: job.requestId } : {}),
    },
    () => runJobInner(job),
  );
}

async function runJobInner(job: Job): Promise<void> {
  // Claim the row — if another worker (or the reaper) already moved it past
  // QUEUED, drop this duplicate enqueue silently.
  let claimed = false;
  try {
    claimed = await taskLog.claimQueued(job.taskId);
  } catch (err) {
    // A DB outage during the claim leaves the row in QUEUED, where a polling
    // client sees no progress until the next reaper sweep. Best-effort mark
    // it FAILED so GET /tasks/:id reaches a terminal state promptly; if this
    // write also fails (DB still down) the reaper remains the backstop.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("claimQueued failed", { error: message });
    try {
      await taskLog.recordWorkerError(job.taskId, `claim_failed: ${message}`);
    } catch (writeErr) {
      logger.error("failed to record claim_failed worker_error", {
        error: (writeErr as Error).message,
      });
    }
    return;
  }
  if (!claimed) return;

  try {
    // routeTask writes the terminal status via markCompleted/markFailed,
    // which atomically stamp status, response_content (on success), and
    // worker_finished_at in a single UPDATE.
    await routeTask(job.input, { taskId: job.taskId });
  } catch (err) {
    // routeTask handles its own failures and writes FAILED to task_log, but
    // any unhandled throw (DB outage, etc.) lands here. Best-effort mark the
    // row FAILED so callers polling GET /tasks/:id see a terminal state.
    const message = err instanceof Error ? err.message : String(err);
    logger.error("uncaught error in routeTask", { error: message });
    try {
      await taskLog.recordWorkerError(job.taskId, message);
    } catch (writeErr) {
      logger.error("failed to record worker_error", {
        error: (writeErr as Error).message,
      });
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
        logger.warn("grace period exceeded", {
          component: "task-worker",
          inflight,
        });
        const r = drainResolver;
        drainResolver = null;
        r();
      }
    }, graceMs).unref();
  });
}

/** Test/observability hook. */
export function inspect(): { queued: number; inflight: number; capacity: number } {
  return { queued: queue.length, inflight, capacity: maxQueueDepth() };
}

/**
 * Pre-flight check used by the HTTP handler to return 429 before
 * inserting a QUEUED row. Avoids creating orphan QUEUED rows that the
 * reaper would have to clean up later.
 */
export function canAccept(): boolean {
  return !stopping && queue.length < maxQueueDepth();
}

/** Test reset — clears in-memory state without touching the DB. */
export function _resetForTests(): void {
  queue.length = 0;
  tracked.clear();
  inflight = 0;
  started = false;
  stopping = false;
  drainResolver = null;
}
