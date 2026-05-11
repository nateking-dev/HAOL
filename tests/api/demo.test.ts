import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stub routeTask before importing createApp so the demo route never reaches
// the real router (no DB / LLM dependencies needed for this test file).
const routeTaskMock = vi.fn();
vi.mock("../../src/router/router.js", () => ({
  routeTask: (...args: unknown[]) => routeTaskMock(...args),
}));

// costSavings is also imported by demo.ts; stub it so the GET handler
// doesn't try to query Dolt.
vi.mock("../../src/observability/queries.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    costSavings: vi.fn().mockResolvedValue({ savings_usd: 0, baseline_usd: 0 }),
  };
});

import { createApp } from "../../src/api/app.js";

const ORIGINAL_FLAG = process.env.HAOL_ENABLE_DEMO;

function buildSuccessfulRouterResponse() {
  routeTaskMock.mockResolvedValue({
    task_id: "01J0TEST",
    status: "COMPLETED",
    complexity_tier: 1,
    selected_agent_id: "agent-x",
    response_content: "ok",
    cost_usd: 0.001,
    latency_ms: 42,
    error: null,
  });
}

describe("/demo gating", () => {
  beforeEach(() => {
    routeTaskMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.HAOL_ENABLE_DEMO;
    } else {
      process.env.HAOL_ENABLE_DEMO = ORIGINAL_FLAG;
    }
  });

  it("returns 404 for /demo/api/task when HAOL_ENABLE_DEMO is unset", async () => {
    delete process.env.HAOL_ENABLE_DEMO;
    const app = createApp();

    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(res.status).toBe(404);
    expect(routeTaskMock).not.toHaveBeenCalled();
  });

  it("returns 404 for /demo/api/savings when HAOL_ENABLE_DEMO is unset", async () => {
    delete process.env.HAOL_ENABLE_DEMO;
    const app = createApp();

    const res = await app.request("/demo/api/savings");
    expect(res.status).toBe(404);
  });

  it("rate-limits POST /demo/api/task to 5 requests per minute (global bucket)", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const send = () =>
      app.request("/demo/api/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });

    // 5 successes
    for (let i = 0; i < 5; i++) {
      const res = await send();
      expect(res.status).toBe(201);
    }

    // 6th rejected with 429, regardless of source IP (global bucket)
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("clamps caller-supplied max_tokens and timeout_ms before invoking routeTask", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "hello",
        constraints: { max_tokens: 8192, timeout_ms: 120_000, temperature: 0.5 },
      }),
    });

    expect(res.status).toBe(201);
    expect(routeTaskMock).toHaveBeenCalledTimes(1);
    const passedInput = routeTaskMock.mock.calls[0][0] as {
      constraints: { max_tokens: number; timeout_ms: number; temperature: number };
    };
    expect(passedInput.constraints.max_tokens).toBe(1024);
    expect(passedInput.constraints.timeout_ms).toBe(15_000);
    // Non-clamped fields pass through untouched.
    expect(passedInput.constraints.temperature).toBe(0.5);
  });

  it("returns 400 for malformed JSON", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid JSON request body",
      details: undefined,
    });
    expect(routeTaskMock).not.toHaveBeenCalled();
  });

  it("applies the clamps even when caller omits constraints entirely", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(res.status).toBe(201);
    const passedInput = routeTaskMock.mock.calls[0][0] as {
      constraints: { max_tokens: number; timeout_ms: number };
    };
    expect(passedInput.constraints.max_tokens).toBe(1024);
    expect(passedInput.constraints.timeout_ms).toBe(15_000);
  });

  it("truncates oversized prompts to bound input-token spend", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    // Zod's RouterTaskInput allows up to 100k chars; demo clamps to 4k.
    const oversized = "a".repeat(50_000);
    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: oversized }),
    });

    expect(res.status).toBe(201);
    const passedInput = routeTaskMock.mock.calls[0][0] as { prompt: string };
    expect(passedInput.prompt.length).toBe(4_000);
  });

  it("leaves prompts within the cap unchanged", async () => {
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const original = "short prompt";
    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: original }),
    });

    expect(res.status).toBe(201);
    const passedInput = routeTaskMock.mock.calls[0][0] as { prompt: string };
    expect(passedInput.prompt).toBe(original);
  });

  it("does not let serveStatic intercept POST /demo/api/task", async () => {
    // Regression: if /demo/* were mounted with app.use() rather than
    // app.get(), serveStatic would run on POST and could serve a matching
    // file from ./public/, bypassing the rate limiter and the handler.
    // We can't create files inside ./public/ from a test, but we can verify
    // the POST reaches our handler by asserting routeTask was invoked.
    process.env.HAOL_ENABLE_DEMO = "1";
    buildSuccessfulRouterResponse();
    const app = createApp();

    const res = await app.request("/demo/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });

    expect(res.status).toBe(201);
    expect(routeTaskMock).toHaveBeenCalledTimes(1);
  });
});
