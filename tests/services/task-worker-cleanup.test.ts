import { describe, it, expect, vi, afterEach } from "vitest";
import * as taskLog from "../../src/repositories/task-log.js";
import * as worker from "../../src/services/task-worker.js";
import type { RouterTaskInput } from "../../src/types/router.js";

// --- Unit test for #13: the `tracked` Set must not leak (no DB required). ---
//
// runJobInner catches its own errors and returns, so runJob resolves even when
// the job's work fails — and the .finally() cleanup runs on that resolution.
// This locks in that a task ID is removed from `tracked` after the job settles
// regardless of internal error handling, so the same ID can be re-enqueued and
// never becomes permanently un-enqueueable.

const INPUT: RouterTaskInput = { prompt: "x" };

function tick(): Promise<void> {
  // Two macrotask hops: one for setImmediate(pump), one for the job's
  // microtask chain + .finally() to settle.
  return new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  vi.restoreAllMocks();
  worker._resetForTests();
});

describe("task-worker — tracked Set cleanup (#13)", () => {
  it("releases the task ID after the job's work errors, so it can be re-enqueued", async () => {
    // Force the job's work to fail at the very first await. runJobInner catches
    // this and returns, so runJob resolves — the .finally() cleanup runs on that
    // resolution, not on a rejection.
    vi.spyOn(taskLog, "claimQueued").mockRejectedValue(new Error("boom"));

    worker.start();
    expect(worker.enqueue("task-1", INPUT)).toBe("ok");
    // Same ID is rejected as a duplicate while still tracked/in-flight.
    expect(worker.enqueue("task-1", INPUT)).toBe("duplicate");

    await tick();

    // Cleanup ran despite the error: nothing in-flight, ID released.
    expect(worker.inspect().inflight).toBe(0);
    expect(worker.enqueue("task-1", INPUT)).toBe("ok");
  });
});
