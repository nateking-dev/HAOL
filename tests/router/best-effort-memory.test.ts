import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _bestEffortMemoryForTests as bestEffortMemory,
  _createMemoryBudgetForTests as createMemoryBudget,
  _memoryInflightForTests,
} from "../../src/router/router.js";

const ORIGINAL_CAP = process.env.MEMORY_MAX_CONCURRENT;
const ORIGINAL_TIMEOUT = process.env.MEMORY_STEP_TIMEOUT_MS;
const ORIGINAL_BUDGET = process.env.MEMORY_TASK_BUDGET_MS;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("bestEffortMemory semaphore", () => {
  beforeEach(() => {
    // Tight cap and short step timeout keep tests fast and the contention
    // path observable. The budget is generous so we're testing the
    // concurrency cap, not the per-task budget.
    process.env.MEMORY_MAX_CONCURRENT = "2";
    process.env.MEMORY_STEP_TIMEOUT_MS = "200";
    process.env.MEMORY_TASK_BUDGET_MS = "10000";
    // Reasoning: prior test runs may leave inflight stuck above zero if
    // they didn't await the work promise; assert clean baseline.
    expect(_memoryInflightForTests()).toBe(0);
  });

  afterEach(() => {
    if (ORIGINAL_CAP === undefined) delete process.env.MEMORY_MAX_CONCURRENT;
    else process.env.MEMORY_MAX_CONCURRENT = ORIGINAL_CAP;
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.MEMORY_STEP_TIMEOUT_MS;
    else process.env.MEMORY_STEP_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    if (ORIGINAL_BUDGET === undefined) delete process.env.MEMORY_TASK_BUDGET_MS;
    else process.env.MEMORY_TASK_BUDGET_MS = ORIGINAL_BUDGET;
    vi.useRealTimers();
  });

  it("caps in-flight memory operations at MEMORY_MAX_CONCURRENT", async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d4 = deferred<string>();

    const budget = createMemoryBudget();
    const p1 = bestEffortMemory("step1", "task-a", budget, () => d1.promise);
    const p2 = bestEffortMemory("step2", "task-b", budget, () => d2.promise);
    expect(_memoryInflightForTests()).toBe(2);

    // Third call exceeds the cap of 2 — must short-circuit (return null)
    // and must NOT invoke fn.
    const fn3 = vi.fn(async () => "should-not-run");
    const p3 = bestEffortMemory("step3", "task-c", budget, fn3);
    await expect(p3).resolves.toBeNull();
    expect(fn3).not.toHaveBeenCalled();
    expect(_memoryInflightForTests()).toBe(2);

    // Release one and verify a new call can now schedule. Use a deferred so
    // the new call stays inflight while we observe the count.
    d1.resolve("first");
    await expect(p1).resolves.toBe("first");
    // Drain the .finally → .catch microtask chain (two ticks).
    await Promise.resolve();
    await Promise.resolve();
    expect(_memoryInflightForTests()).toBe(1);

    const fn4 = vi.fn(() => d4.promise);
    const p4 = bestEffortMemory("step4", "task-d", budget, fn4);
    expect(fn4).toHaveBeenCalledTimes(1);
    expect(_memoryInflightForTests()).toBe(2);

    // Drain everything so the next test starts clean.
    d2.resolve("second");
    d4.resolve("fourth");
    await p2;
    await p4;
    await Promise.resolve();
    await Promise.resolve();
    expect(_memoryInflightForTests()).toBe(0);
  });

  it("releases the slot when fn settles, even after the timeout fires first", async () => {
    // Step timeout = 200ms; fn won't resolve for 400ms. Caller sees null
    // (timeout error swallowed), but the slot must release when fn finally
    // settles, not when the caller returned.
    const d = deferred<string>();
    const budget = createMemoryBudget();
    const result = bestEffortMemory("slow", "task-x", budget, () => d.promise);
    await Promise.resolve();
    expect(_memoryInflightForTests()).toBe(1);

    // Timeout will fire at 200ms — caller resolves with null.
    await expect(result).resolves.toBeNull();
    // Slot is still held: fn() hasn't settled.
    expect(_memoryInflightForTests()).toBe(1);

    // Release fn → the .finally chain decrements.
    d.resolve("late");
    // Wait for microtask queue to flush both the .finally and the .catch.
    await Promise.resolve();
    await Promise.resolve();
    expect(_memoryInflightForTests()).toBe(0);
  });

  it("late rejection from a timed-out fn does not surface as unhandled", async () => {
    // Catches the regression: without the dangling .catch, the timed-out
    // fn's eventual rejection would log "unhandledRejection" because
    // Promise.race already resolved via the timeout path.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const d = deferred<string>();
      const budget = createMemoryBudget();
      const result = bestEffortMemory("doomed", "task-y", budget, () => d.promise);
      await expect(result).resolves.toBeNull();

      d.reject(new Error("late dolt failure"));
      // Allow Node's microtask + nextTick + uncaught-rejection scheduling
      // to surface anything we didn't observe.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      // Slot still releases on rejection.
      expect(_memoryInflightForTests()).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns null with no fn invocation when the per-task budget is exhausted", async () => {
    // Budget = 100ms (router.ts floors any sub-100 value back to the
    // default), sleep past it before scheduling anything.
    process.env.MEMORY_TASK_BUDGET_MS = "100";
    const budget = createMemoryBudget();
    await new Promise((r) => setTimeout(r, 150));

    const fn = vi.fn(async () => "ran");
    const result = await bestEffortMemory("after-budget", "task-z", budget, fn);
    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(_memoryInflightForTests()).toBe(0);
  });
});
