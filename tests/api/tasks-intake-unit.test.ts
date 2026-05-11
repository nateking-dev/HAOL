import { describe, it, expect, beforeEach, vi } from "vitest";

const createQueuedMock = vi.fn();
const recordWorkerErrorMock = vi.fn();
const canAcceptMock = vi.fn();
const enqueueMock = vi.fn();

vi.mock("../../src/repositories/task-log.js", () => ({
  createQueued: (...args: unknown[]) => createQueuedMock(...args),
  recordWorkerError: (...args: unknown[]) => recordWorkerErrorMock(...args),
  findById: vi.fn(),
}));

vi.mock("../../src/repositories/execution-log.js", () => ({
  findByTaskId: vi.fn(),
}));

vi.mock("../../src/cascade-router/reference-store.js", () => ({
  findTraceByTaskId: vi.fn(),
}));

vi.mock("../../src/services/task-worker.js", () => ({
  canAccept: (...args: unknown[]) => canAcceptMock(...args),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
}));

import { createApp } from "../../src/api/app.js";

describe("POST /tasks intake failure handling", () => {
  beforeEach(() => {
    createQueuedMock.mockReset().mockResolvedValue(undefined);
    recordWorkerErrorMock.mockReset().mockResolvedValue(undefined);
    canAcceptMock.mockReset().mockReturnValue(true);
    enqueueMock.mockReset().mockReturnValue("ok");
  });

  it("returns 429 before inserting when the worker queue is saturated", async () => {
    canAcceptMock.mockReturnValue(false);
    const app = createApp();

    const res = await app.request("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "summarize this" }),
    });

    expect(res.status).toBe(429);
    expect(createQueuedMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("marks the inserted row failed if enqueue loses the post-insert race", async () => {
    enqueueMock.mockReturnValue("queue_full");
    const app = createApp();

    const res = await app.request("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "summarize this" }),
    });
    const body = (await res.json()) as { task_id: string; status: string };

    expect(res.status).toBe(429);
    expect(body.task_id).toBeTruthy();
    expect(body.status).toBe("FAILED");
    expect(createQueuedMock).toHaveBeenCalledTimes(1);
    expect(recordWorkerErrorMock).toHaveBeenCalledWith(body.task_id, "enqueue_failed:queue_full");
  });

  it("returns 400 for malformed JSON before touching intake state", async () => {
    const app = createApp();

    const res = await app.request("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    expect(res.status).toBe(400);
    expect(createQueuedMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
