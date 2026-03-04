import { describe, it, expect, afterEach, vi } from "vitest";
import { statsCommand } from "../../src/cli/commands/stats.js";
import { run } from "../../src/cli/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SAMPLE_DASHBOARD = {
  period_hours: 24,
  cost: [
    { agent_id: "claude-haiku", total_cost: 0.025, invocations: 10 },
    { agent_id: "gpt-4o-mini", total_cost: 0.012, invocations: 5 },
  ],
  latency: [
    { agent_id: "claude-haiku", avg_latency_ms: 300 },
    { agent_id: "gpt-4o-mini", avg_latency_ms: 450 },
  ],
  failures: [
    { agent_id: "claude-haiku", total: 10, failures: 1, rate: 0.1 },
    { agent_id: "gpt-4o-mini", total: 5, failures: 0, rate: 0 },
  ],
  tiers: [
    { tier: 1, count: 8 },
    { tier: 2, count: 5 },
    { tier: 3, count: 2 },
  ],
  totals: {
    total_cost: 0.037,
    total_invocations: 15,
    total_tasks: 15,
    avg_failure_rate: 0.067,
  },
};

function mockDashboard(data: unknown = SAMPLE_DASHBOARD, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe("stats command", () => {
  it("prints formatted dashboard", async () => {
    mockDashboard();

    const output = await statsCommand({
      format: "table",
      baseUrl: "http://localhost:3000",
    });

    expect(output).toContain("HAOL Dashboard");
    expect(output).toContain("$0.0370");
    expect(output).toContain("15");
    expect(output).toContain("6.7%");
    expect(output).toContain("claude-haiku");
    expect(output).toContain("Cost by Agent");
    expect(output).toContain("Avg Latency by Agent");
    expect(output).toContain("Failure Rates");
    expect(output).toContain("Tasks by Tier");
  });

  it("outputs valid JSON", async () => {
    mockDashboard();

    const output = await statsCommand({
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const parsed = JSON.parse(output);
    expect(parsed.period_hours).toBe(24);
    expect(parsed.totals.total_cost).toBe(0.037);
  });

  it("passes hours query param", async () => {
    mockDashboard();

    await statsCommand({
      hours: 48,
      format: "json",
      baseUrl: "http://localhost:3000",
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("hours=48");
  });
});

describe("run() — stats via CLI entry", () => {
  it("haol stats prints dashboard", async () => {
    mockDashboard();
    const output = await run(["node", "haol", "stats"]);
    expect(output).toContain("HAOL Dashboard");
  });

  it("haol stats --hours 48 passes hours", async () => {
    mockDashboard();
    await run(["node", "haol", "stats", "--hours", "48"]);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("hours=48");
  });

  it("haol stats --format json outputs JSON", async () => {
    mockDashboard();
    const output = await run(["node", "haol", "stats", "--format", "json"]);
    const parsed = JSON.parse(output);
    expect(parsed.totals).toBeTruthy();
  });
});
