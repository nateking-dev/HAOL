import { describe, it, expect, afterEach, vi } from "vitest";
import { taskCommand } from "../../src/cli/commands/task.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Mocks the async POST 202 → GET poll flow. POST returns 202 with a
 * task_id; subsequent GETs return the completion payload (done=true).
 */
function mockAsyncFlow(completion: Record<string, unknown>, taskId = "abc-123") {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && u.endsWith("/tasks")) {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          task_id: taskId,
          status: "QUEUED",
          links: { self: `/tasks/${taskId}` },
        }),
      };
    }
    // GET poll
    return {
      ok: true,
      status: 200,
      json: async () => ({ task_id: taskId, done: true, ...completion }),
    };
  }) as unknown as typeof fetch;
}

function mockPostError(status: number, body: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("task command", () => {
  it("polls after 202 and prints task_id and response in table format", async () => {
    mockAsyncFlow({
      status: "COMPLETED",
      complexity_tier: 1,
      selected_agent_id: "haiku",
      response_content: "Here is your summary.",
      cost_usd: 0.0012,
      latency_ms: 450,
      error: null,
    });

    const output = await taskCommand({
      prompt: "Summarize this",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("abc-123");
    expect(output).toContain("COMPLETED");
    expect(output).toContain("Here is your summary.");
    expect(output).toContain("$0.0012");
    expect(output).toContain("450ms");
  });

  it("outputs valid JSON in json format", async () => {
    mockAsyncFlow({
      status: "COMPLETED",
      complexity_tier: 1,
      selected_agent_id: "haiku",
      response_content: "Done.",
      cost_usd: 0.001,
      latency_ms: 200,
      error: null,
    });

    const output = await taskCommand({
      prompt: "Hello",
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const parsed = JSON.parse(output);
    expect(parsed.task_id).toBe("abc-123");
    expect(parsed.status).toBe("COMPLETED");
  });

  it("outputs minimal format", async () => {
    mockAsyncFlow({
      status: "COMPLETED",
      response_content: "Result",
      error: null,
    });

    const output = await taskCommand({
      prompt: "Hello",
      format: "minimal",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("abc-123");
    expect(output).toContain("COMPLETED");
    expect(output).toContain("Result");
  });

  it("shows error on POST failure (no polling)", async () => {
    mockPostError(500, { error: "No agent available" });

    const output = await taskCommand({
      prompt: "Hello",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("Error");
    expect(output).toContain("No agent available");
  });

  it("waitTimeoutMs=0 skips the poll and returns the QUEUED handle", async () => {
    mockAsyncFlow({ status: "COMPLETED", response_content: "should not appear" });

    const output = await taskCommand({
      prompt: "fire and forget",
      format: "minimal",
      baseUrl: "http://localhost:3000",
      waitTimeoutMs: 0,
    });

    expect(output).toContain("abc-123");
    expect(output).toContain("QUEUED");
    expect(output).not.toContain("should not appear");
  });

  it("sends tier and capabilities metadata", async () => {
    mockAsyncFlow({ status: "COMPLETED" });

    await taskCommand({
      prompt: "Test",
      tier: 3,
      capabilities: ["reasoning", "code_generation"],
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1]?.method ?? "GET") === "POST",
    )!;
    const body = JSON.parse((postCall[1] as { body: string }).body);
    expect(body.metadata.tier).toBe(3);
    expect(body.metadata.capabilities).toEqual(["reasoning", "code_generation"]);
  });
});

describe("run() — task command via CLI entry", () => {
  it("haol task 'hello' invokes task command", async () => {
    mockAsyncFlow(
      {
        status: "COMPLETED",
        complexity_tier: 1,
        selected_agent_id: "haiku",
        response_content: "Hello!",
        cost_usd: 0.001,
        latency_ms: 100,
        error: null,
      },
      "run-test",
    );

    const output = await run(["node", "haol", "task", "hello"]);
    expect(output).toContain("run-test");
    expect(output).toContain("Hello!");
  });

  it("haol task with --tier and --cap flags", async () => {
    mockAsyncFlow({ status: "COMPLETED" }, "t");

    await run(["node", "haol", "task", "test", "--tier", "3", "--cap", "reasoning"]);

    const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1]?.method ?? "GET") === "POST",
    )!;
    const body = JSON.parse((postCall[1] as { body: string }).body);
    expect(body.metadata.tier).toBe(3);
    expect(body.metadata.capabilities).toEqual(["reasoning"]);
  });

  it("missing prompt shows usage hint", async () => {
    const output = await run(["node", "haol", "task"]);
    expect(output).toContain("Error: prompt is required");
  });
});
