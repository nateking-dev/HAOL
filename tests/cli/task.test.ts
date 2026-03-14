import { describe, it, expect, afterEach, vi } from "vitest";
import { taskCommand } from "../../src/cli/commands/task.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockTaskResponse(data: Record<string, unknown>, status = 201) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe("task command", () => {
  it("prints task_id and response in table format", async () => {
    mockTaskResponse({
      task_id: "abc-123",
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
    const data = {
      task_id: "abc-123",
      status: "COMPLETED",
      complexity_tier: 1,
      selected_agent_id: "haiku",
      response_content: "Done.",
      cost_usd: 0.001,
      latency_ms: 200,
      error: null,
    };
    mockTaskResponse(data);

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
    mockTaskResponse({
      task_id: "abc-123",
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

  it("shows error on failure", async () => {
    mockTaskResponse({ error: "No agent available" }, 500);

    const output = await taskCommand({
      prompt: "Hello",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("Error");
    expect(output).toContain("No agent available");
  });

  it("sends tier and capabilities metadata", async () => {
    mockTaskResponse({ task_id: "x", status: "COMPLETED" });

    await taskCommand({
      prompt: "Test",
      tier: 3,
      capabilities: ["reasoning", "code_generation"],
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.metadata.tier).toBe(3);
    expect(body.metadata.capabilities).toEqual(["reasoning", "code_generation"]);
  });
});

describe("run() — task command via CLI entry", () => {
  it("haol task 'hello' invokes task command", async () => {
    mockTaskResponse({
      task_id: "run-test",
      status: "COMPLETED",
      complexity_tier: 1,
      selected_agent_id: "haiku",
      response_content: "Hello!",
      cost_usd: 0.001,
      latency_ms: 100,
      error: null,
    });

    const output = await run(["node", "haol", "task", "hello"]);
    expect(output).toContain("run-test");
    expect(output).toContain("Hello!");
  });

  it("haol task with --tier and --cap flags", async () => {
    mockTaskResponse({ task_id: "t", status: "COMPLETED" });

    await run(["node", "haol", "task", "test", "--tier", "3", "--cap", "reasoning"]);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.metadata.tier).toBe(3);
    expect(body.metadata.capabilities).toEqual(["reasoning"]);
  });

  it("missing prompt shows usage hint", async () => {
    const output = await run(["node", "haol", "task"]);
    expect(output).toContain("Error: prompt is required");
  });
});
