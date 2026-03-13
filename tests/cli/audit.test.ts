import { describe, it, expect, afterEach, vi } from "vitest";
import {
  auditAgentsCommand,
  auditCommitsCommand,
} from "../../src/cli/commands/audit.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(data: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe("audit agents command", () => {
  it("shows agent changes in table format", async () => {
    mockResponse([
      {
        diff_type: "modified",
        to_agent_id: "claude-haiku",
        from_status: "active",
        to_status: "disabled",
      },
    ]);

    const output = await auditAgentsCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("modified");
    expect(output).toContain("claude-haiku");
    expect(output).toContain("disabled");
  });

  it("passes since param", async () => {
    mockResponse([]);

    await auditAgentsCommand({
      since: "3d",
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("since=3d");
  });

  it("shows (no agent changes) for empty result", async () => {
    mockResponse([]);

    const output = await auditAgentsCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("(no agent changes)");
  });

  it("outputs valid JSON", async () => {
    mockResponse([{ diff_type: "added", to_agent_id: "new-agent" }]);

    const output = await auditAgentsCommand({
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("audit commits command", () => {
  it("shows commits in table format", async () => {
    mockResponse([
      {
        hash: "abc123def456",
        message: "task:xyz | tier:T1 | agent:haiku | cost:$0.005",
        date: "2026-03-04T10:00:00Z",
        author: "haol-router",
      },
    ]);

    const output = await auditCommitsCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("abc123def456");
    expect(output).toContain("task:xyz");
    expect(output).toContain("haol-router");
  });

  it("passes limit param", async () => {
    mockResponse([]);

    await auditCommitsCommand({
      last: 10,
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("limit=10");
  });

  it("shows (no commits) for empty result", async () => {
    mockResponse([]);

    const output = await auditCommitsCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("(no commits)");
  });
});

describe("run() — audit via CLI entry", () => {
  it("haol audit agents shows changes", async () => {
    mockResponse([
      {
        diff_type: "added",
        to_agent_id: "test-agent",
        from_status: null,
        to_status: "active",
      },
    ]);
    const output = await run(["node", "haol", "audit", "agents"]);
    expect(output).toContain("test-agent");
  });

  it("haol audit commits shows commits", async () => {
    mockResponse([{ hash: "abc123", message: "test commit", date: "2026-03-04", author: "test" }]);
    const output = await run(["node", "haol", "audit", "commits"]);
    expect(output).toContain("test commit");
  });

  it("haol audit without subcommand shows error", async () => {
    const output = await run(["node", "haol", "audit"]);
    expect(output).toContain("Error: subcommand required");
  });

  it("haol audit agents --since 3d passes param", async () => {
    mockResponse([]);
    await run(["node", "haol", "audit", "agents", "--since", "3d"]);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("since=3d");
  });

  it("haol audit commits --last 5 passes limit", async () => {
    mockResponse([]);
    await run(["node", "haol", "audit", "commits", "--last", "5"]);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("limit=5");
  });
});
