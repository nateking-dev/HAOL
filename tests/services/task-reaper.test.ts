import { describe, it, expect, vi, afterEach } from "vitest";
import * as taskLog from "../../src/repositories/task-log.js";
import * as worker from "../../src/services/task-worker.js";
import * as branchCleanup from "../../src/memory/branch-cleanup.js";
import * as referenceStore from "../../src/cascade-router/reference-store.js";
import { runReaperOnce } from "../../src/services/task-reaper.js";

// --- Unit tests for the QUEUED re-enqueue paging drain (no DB required). ---
//
// These mock the repository + worker layers so we can assert the reaper pages
// through the backlog (keyset cursor) instead of loading every QUEUED row at
// once (fix #16), advancing the cursor correctly and stopping on a short page.

function makeRecord(
  taskId: string,
  createdAt: string,
  prompt: string | null = "p",
): taskLog.TaskLogRecord {
  return {
    task_id: taskId,
    created_at: createdAt,
    status: "QUEUED",
    prompt_hash: null,
    prompt,
    input_metadata: null,
    input_constraints: null,
    complexity_tier: null,
    required_capabilities: null,
    cost_ceiling_usd: null,
    selected_agent_id: null,
    selection_rationale: null,
    routing_confidence: null,
    routing_layer: null,
    expected_format: null,
    worker_started_at: null,
    worker_finished_at: null,
    worker_error: null,
    response_content: null,
  };
}

/** Build a findQueuedPage mock that serves `all` in (created_at, task_id) keyset order. */
// created_at is `string | Date` at the type level (Date at runtime from mysql2).
// Coerce to a comparable string so the mock's keyset logic handles both forms,
// matching how the real SQL orders the column.
function ts(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function pagedSource(all: taskLog.TaskLogRecord[]) {
  const sorted = [...all].sort((a, b) =>
    ts(a.created_at) === ts(b.created_at)
      ? a.task_id.localeCompare(b.task_id)
      : ts(a.created_at).localeCompare(ts(b.created_at)),
  );
  return async (limit: number, after?: taskLog.QueuedCursor): Promise<taskLog.TaskLogRecord[]> => {
    const start = after
      ? sorted.findIndex(
          (r) =>
            ts(r.created_at) > ts(after.created_at) ||
            (ts(r.created_at) === ts(after.created_at) && r.task_id > after.task_id),
        )
      : 0;
    if (start === -1) return [];
    return sorted.slice(start, start + limit);
  };
}

function stubNonQueuedWork() {
  // Isolate the QUEUED re-enqueue path: no stale rows, no branch pruning, no
  // retention purge (otherwise it would reach for a real DB pool).
  vi.spyOn(taskLog, "findStale").mockResolvedValue([]);
  vi.spyOn(branchCleanup, "pruneSessionBranches").mockResolvedValue([]);
  vi.spyOn(taskLog, "purgeExpiredPrompts").mockResolvedValue(0);
  vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WORKER_REQUEUE_PAGE_SIZE;
  delete process.env.PROMPT_RETENTION_DAYS;
});

describe("task-reaper — QUEUED re-enqueue paging", () => {
  it("pages through the full backlog and re-enqueues every row", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "2";
    stubNonQueuedWork();

    const rows = [
      makeRecord("a", "2026-06-01 00:00:01"),
      makeRecord("b", "2026-06-01 00:00:02"),
      makeRecord("c", "2026-06-01 00:00:03"),
      makeRecord("d", "2026-06-01 00:00:04"),
      makeRecord("e", "2026-06-01 00:00:05"),
    ];
    const pageSpy = vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(worker, "enqueue").mockReturnValue("ok");

    const result = await runReaperOnce();

    expect(result.reEnqueued).toBe(5);
    expect(enqueueSpy.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "d", "e"]);
    // 5 rows / page size 2 => pages of [2,2,1]; the short final page ends the drain.
    expect(pageSpy).toHaveBeenCalledTimes(3);
    // Second call must carry the cursor from the last row of page 1 (task "b").
    expect(pageSpy.mock.calls[1][1]).toEqual({ created_at: "2026-06-01 00:00:02", task_id: "b" });
  });

  it("stops early without pulling more pages once the worker can't accept", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "2";
    stubNonQueuedWork();

    const rows = [
      makeRecord("a", "2026-06-01 00:00:01"),
      makeRecord("b", "2026-06-01 00:00:02"),
      makeRecord("c", "2026-06-01 00:00:03"),
      makeRecord("d", "2026-06-01 00:00:04"),
    ];
    const pageSpy = vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    // Accept the first row, then refuse — the reaper should leave the rest QUEUED.
    vi.spyOn(worker, "canAccept").mockReturnValueOnce(true).mockReturnValue(false);
    const enqueueSpy = vi.spyOn(worker, "enqueue").mockReturnValue("ok");

    const result = await runReaperOnce();

    expect(result.reEnqueued).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    // Only the first page was fetched — no further prompts loaded into memory.
    expect(pageSpy).toHaveBeenCalledTimes(1);
  });

  it("fails rows that have no stashed prompt instead of enqueuing them", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "10";
    stubNonQueuedWork();

    const rows = [
      makeRecord("a", "2026-06-01 00:00:01", "real prompt"),
      makeRecord("b", "2026-06-01 00:00:02", null),
    ];
    vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(worker, "enqueue").mockReturnValue("ok");
    const errSpy = vi.spyOn(taskLog, "recordWorkerError").mockResolvedValue();

    const result = await runReaperOnce();

    expect(result.reEnqueued).toBe(1);
    expect(result.failed).toBe(1);
    expect(enqueueSpy.mock.calls.map((c) => c[0])).toEqual(["a"]);
    expect(errSpy).toHaveBeenCalledWith("b", "queued_without_prompt");
  });

  it("advances by task_id when a page boundary splits a same-second group", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "2";
    stubNonQueuedWork();

    // a, b, c all share one second; the page boundary falls between b and c.
    // Page 2 must resolve via the (created_at = ? AND task_id > ?) tie-break —
    // a `created_at > ?` predicate alone would skip c (same second as cursor).
    const rows = [
      makeRecord("a", "2026-06-01 00:00:01"),
      makeRecord("b", "2026-06-01 00:00:01"),
      makeRecord("c", "2026-06-01 00:00:01"),
      makeRecord("d", "2026-06-01 00:00:02"),
    ];
    const pageSpy = vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(worker, "enqueue").mockReturnValue("ok");

    const result = await runReaperOnce();

    // Every row enqueued exactly once, in order — nothing skipped or repeated.
    expect(enqueueSpy.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "d"]);
    expect(result.reEnqueued).toBe(4);
    // The page-2 cursor carries the same-second timestamp + the last task_id.
    expect(pageSpy.mock.calls[1][1]).toEqual({ created_at: "2026-06-01 00:00:01", task_id: "b" });
  });

  it("stops draining (and keeps the first page's count) when a later page fails", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "2";
    stubNonQueuedWork();

    // First page returns a full page (so the loop wants another), the second
    // call throws — the reaper should log and stop, not crash, and the rows
    // already enqueued from page 1 must still count.
    const pageSpy = vi
      .spyOn(taskLog, "findQueuedPage")
      .mockResolvedValueOnce([
        makeRecord("a", "2026-06-01 00:00:01"),
        makeRecord("b", "2026-06-01 00:00:02"),
      ])
      .mockRejectedValueOnce(new Error("db gone"));
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    const enqueueSpy = vi.spyOn(worker, "enqueue").mockReturnValue("ok");

    const result = await runReaperOnce();

    expect(result.reEnqueued).toBe(2);
    expect(enqueueSpy.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(pageSpy).toHaveBeenCalledTimes(2);
  });

  it("counts duplicate enqueues separately and does not inflate reEnqueued (fix #14)", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "10";
    stubNonQueuedWork();

    const rows = [
      makeRecord("a", "2026-06-01 00:00:01"),
      makeRecord("b", "2026-06-01 00:00:02"),
      makeRecord("c", "2026-06-01 00:00:03"),
    ];
    vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    // b was already re-queued by a live worker — enqueue refuses it as a dup.
    const enqueueSpy = vi
      .spyOn(worker, "enqueue")
      .mockReturnValueOnce("ok")
      .mockReturnValueOnce("duplicate")
      .mockReturnValueOnce("ok");

    const result = await runReaperOnce();

    expect(enqueueSpy).toHaveBeenCalledTimes(3);
    expect(result.reEnqueued).toBe(2);
    expect(result.duplicates).toBe(1);
  });

  it("stops the drain when enqueue reports queue_full even though canAccept passed (fix #14)", async () => {
    process.env.WORKER_REQUEUE_PAGE_SIZE = "10";
    stubNonQueuedWork();

    const rows = [
      makeRecord("a", "2026-06-01 00:00:01"),
      makeRecord("b", "2026-06-01 00:00:02"),
      makeRecord("c", "2026-06-01 00:00:03"),
    ];
    vi.spyOn(taskLog, "findQueuedPage").mockImplementation(pagedSource(rows));
    // canAccept is a stale pre-flight hint here: it keeps saying yes, but the
    // queue fills between the check and the enqueue, so enqueue refuses "b".
    vi.spyOn(worker, "canAccept").mockReturnValue(true);
    const enqueueSpy = vi
      .spyOn(worker, "enqueue")
      .mockReturnValueOnce("ok")
      .mockReturnValueOnce("queue_full");

    const result = await runReaperOnce();

    // Only "a" landed; the drain stopped at the queue_full without trying "c".
    expect(result.reEnqueued).toBe(1);
    expect(enqueueSpy.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });
});

// --- PII retention purge (#79). Mocks the repository layer so we assert the
// reaper passes the configured window through and isolates purge failures. ---

describe("task-reaper — PII retention purge", () => {
  // Isolate the purge step: empty queue, no stale rows, no branch pruning.
  function stubOtherWork() {
    vi.spyOn(taskLog, "findQueuedPage").mockResolvedValue([]);
    vi.spyOn(taskLog, "findStale").mockResolvedValue([]);
    vi.spyOn(branchCleanup, "pruneSessionBranches").mockResolvedValue([]);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PROMPT_RETENTION_DAYS;
  });

  it("purges expired prompt + input_text with the default 30-day window", async () => {
    stubOtherWork();
    const prompts = vi.spyOn(taskLog, "purgeExpiredPrompts").mockResolvedValue(3);
    const inputs = vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(2);

    const result = await runReaperOnce();

    expect(prompts).toHaveBeenCalledWith(30);
    expect(inputs).toHaveBeenCalledWith(30);
    // Both tables roll up into a single counter.
    expect(result.promptsPurged).toBe(5);
  });

  it("honors a custom PROMPT_RETENTION_DAYS", async () => {
    process.env.PROMPT_RETENTION_DAYS = "7";
    stubOtherWork();
    const prompts = vi.spyOn(taskLog, "purgeExpiredPrompts").mockResolvedValue(0);
    const inputs = vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(0);

    await runReaperOnce();

    expect(prompts).toHaveBeenCalledWith(7);
    expect(inputs).toHaveBeenCalledWith(7);
  });

  it("disables the purge when PROMPT_RETENTION_DAYS <= 0", async () => {
    process.env.PROMPT_RETENTION_DAYS = "0";
    stubOtherWork();
    const prompts = vi.spyOn(taskLog, "purgeExpiredPrompts").mockResolvedValue(0);
    const inputs = vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(0);

    const result = await runReaperOnce();

    expect(prompts).not.toHaveBeenCalled();
    expect(inputs).not.toHaveBeenCalled();
    expect(result.promptsPurged).toBe(0);
  });

  it("falls back to the default for a non-numeric PROMPT_RETENTION_DAYS", async () => {
    process.env.PROMPT_RETENTION_DAYS = "not-a-number";
    stubOtherWork();
    const prompts = vi.spyOn(taskLog, "purgeExpiredPrompts").mockResolvedValue(0);
    vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(0);

    await runReaperOnce();

    expect(prompts).toHaveBeenCalledWith(30);
  });

  it("isolates a failure in one purge from the other and the rest of the sweep", async () => {
    stubOtherWork();
    vi.spyOn(taskLog, "purgeExpiredPrompts").mockRejectedValue(new Error("db gone"));
    const inputs = vi.spyOn(referenceStore, "purgeExpiredInputText").mockResolvedValue(4);

    const result = await runReaperOnce();

    // The prompt purge threw, but input_text purge still ran and counted.
    expect(inputs).toHaveBeenCalledWith(30);
    expect(result.promptsPurged).toBe(4);
  });
});
