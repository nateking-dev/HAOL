import { describe, it, expect, vi } from "vitest";

const recordDownstreamOutcomeMock = vi.fn();

vi.mock("../../src/services/outcome-collector.js", () => ({
  recordDownstreamOutcome: (...args: unknown[]) => recordDownstreamOutcomeMock(...args),
}));

vi.mock("../../src/repositories/task-outcome.js", () => ({
  findByTaskId: vi.fn(),
  findByTaskIdAndTier: vi.fn(),
}));

vi.mock("../../src/repositories/task-log.js", () => ({
  findById: vi.fn(),
}));

import { createApp } from "../../src/api/app.js";

describe("POST /tasks/:id/outcome body parsing", () => {
  it("returns 400 for malformed JSON before recording an outcome", async () => {
    const app = createApp();

    const res = await app.request("/v1/tasks/task-1/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON request body" });
    expect(recordDownstreamOutcomeMock).not.toHaveBeenCalled();
  });
});
