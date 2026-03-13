import { describe, it, expect, afterEach, vi } from "vitest";
import {
  agentsListCommand,
  agentsUpdateCommand,
  agentsRemoveCommand,
} from "../../src/cli/commands/agents.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SAMPLE_AGENTS = [
  {
    agent_id: "claude-haiku",
    provider: "anthropic",
    model_id: "claude-haiku-4-5-20251001",
    status: "active",
    tier_ceiling: 2,
    capabilities: ["summarization", "classification"],
    avg_latency_ms: 300,
  },
  {
    agent_id: "gpt-4o-mini",
    provider: "openai",
    model_id: "gpt-4o-mini",
    status: "active",
    tier_ceiling: 2,
    capabilities: ["summarization"],
    avg_latency_ms: 400,
  },
];

function mockList(data: unknown = SAMPLE_AGENTS, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe("agents list command", () => {
  it("table format shows all columns", async () => {
    mockList();

    const output = await agentsListCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("agent_id");
    expect(output).toContain("claude-haiku");
    expect(output).toContain("gpt-4o-mini");
    expect(output).toContain("anthropic");
    expect(output).toContain("active");
  });

  it("json format returns valid JSON", async () => {
    mockList();

    const output = await agentsListCommand({
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it("passes status filter as query param", async () => {
    mockList();

    await agentsListCommand({
      status: "active",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("status=active");
  });

  it("shows (no results) for empty list", async () => {
    mockList([]);

    const output = await agentsListCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("(no results)");
  });
});

describe("agents update command", () => {
  it("sends PUT request with status field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agent_id: "haiku", status: "disabled" }),
    }) as unknown as typeof fetch;

    const output = await agentsUpdateCommand({
      agentId: "haiku",
      status: "disabled",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("haiku updated");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/agents/haiku");
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body);
    expect(body.status).toBe("disabled");
  });
});

describe("agents remove command", () => {
  it("sends DELETE request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Agent haiku disabled" }),
    }) as unknown as typeof fetch;

    const output = await agentsRemoveCommand(
      "haiku",
      "http://localhost:3000",
      "table",
    );

    expect(output).toContain("haiku disabled");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("/agents/haiku");
    expect(call[1].method).toBe("DELETE");
  });
});

describe("run() — agents command via CLI entry", () => {
  it("haol agents list invokes list", async () => {
    mockList();
    const output = await run(["node", "haol", "agents", "list"]);
    expect(output).toContain("claude-haiku");
  });

  it("haol agents list --status active passes filter", async () => {
    mockList();
    await run(["node", "haol", "agents", "list", "--status", "active"]);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("status=active");
  });

  it("haol agents list --format json outputs JSON", async () => {
    mockList();
    const output = await run([
      "node",
      "haol",
      "agents",
      "list",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("haol agents update without id shows error", async () => {
    const output = await run(["node", "haol", "agents", "update"]);
    expect(output).toContain("Error: agent_id is required");
  });
});
