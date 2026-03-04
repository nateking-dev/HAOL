import { describe, it, expect, afterEach, vi } from "vitest";
import { statusCommand } from "../../src/cli/commands/status.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SAMPLE_TASK = {
  task_id: "abc-123",
  status: "COMPLETED",
  created_at: "2026-03-04T10:00:00.000Z",
  complexity_tier: 2,
  required_capabilities: ["summarization", "reasoning"],
  cost_ceiling_usd: 0.05,
  selected_agent_id: "claude-sonnet",
  executions: [
    {
      attempt_number: 1,
      outcome: "SUCCESS",
      agent_id: "claude-sonnet",
      latency_ms: 800,
      cost_usd: 0.0045,
      input_tokens: 150,
      output_tokens: 75,
    },
  ],
};

function mockStatus(data: unknown = SAMPLE_TASK, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe("status command", () => {
  it("shows lifecycle stages with timestamps", async () => {
    mockStatus();

    const output = await statusCommand({
      taskId: "abc-123",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("abc-123");
    expect(output).toContain("COMPLETED");
    expect(output).toContain("T2");
    expect(output).toContain("claude-sonnet");
    expect(output).toContain("summarization, reasoning");
    expect(output).toContain("Executions:");
    expect(output).toContain("SUCCESS");
    expect(output).toContain("800ms");
  });

  it("json format returns valid JSON", async () => {
    mockStatus();

    const output = await statusCommand({
      taskId: "abc-123",
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const parsed = JSON.parse(output);
    expect(parsed.task_id).toBe("abc-123");
    expect(parsed.executions).toHaveLength(1);
  });

  it("minimal format shows task_id and status", async () => {
    mockStatus();

    const output = await statusCommand({
      taskId: "abc-123",
      format: "minimal",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("abc-123");
    expect(output).toContain("COMPLETED");
  });

  it("shows error for non-existent task", async () => {
    mockStatus({ error: "Task not found: xyz" }, 404);

    const output = await statusCommand({
      taskId: "xyz",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("Error (404)");
    expect(output).toContain("Task not found");
  });

  it("fetches correct URL", async () => {
    mockStatus();

    await statusCommand({
      taskId: "abc-123",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://localhost:3000/tasks/abc-123");
  });
});

describe("run() — status command via CLI entry", () => {
  it("haol status <id> shows task details", async () => {
    mockStatus();
    const output = await run(["node", "haol", "status", "abc-123"]);
    expect(output).toContain("abc-123");
    expect(output).toContain("COMPLETED");
  });

  it("haol status without id shows error", async () => {
    const output = await run(["node", "haol", "status"]);
    expect(output).toContain("Error: task_id is required");
  });
});

describe("run() — general CLI behavior", () => {
  it("no arguments shows usage", async () => {
    const output = await run(["node", "haol"]);
    expect(output).toContain("Usage: haol");
  });

  it("--help shows usage", async () => {
    const output = await run(["node", "haol", "--help"]);
    expect(output).toContain("Usage: haol");
  });

  it("unknown command shows error with usage", async () => {
    const output = await run(["node", "haol", "foobar"]);
    expect(output).toContain("Unknown command: foobar");
    expect(output).toContain("Usage: haol");
  });
});
