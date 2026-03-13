import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import { execute } from "../../src/services/execution.js";
import * as execRepo from "../../src/repositories/execution-log.js";
import type { AgentRequest } from "../../src/types/execution.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// --- Unit tests (no DB required) ---

describe("execution service — unit tests", () => {
  it("cost calculation: cost_usd = (input/1000 * rate_in) + (output/1000 * rate_out)", async () => {
    // Mock the agent-registry findById
    const agentRegistryMod =
      await import("../../src/repositories/agent-registry.js");
    const findByIdSpy = vi
      .spyOn(agentRegistryMod, "findById")
      .mockResolvedValue({
        agent_id: "test-agent-cost",
        provider: "anthropic",
        model_id: "claude-haiku-4-5-20251001",
        capabilities: ["summarization"],
        cost_per_1k_input: 0.25,
        cost_per_1k_output: 1.25,
        max_context_tokens: 200000,
        avg_latency_ms: 500,
        status: "active",
        tier_ceiling: 2,
      });

    // Mock insertExecution to capture the record
    const insertSpy = vi.spyOn(execRepo, "insertExecution").mockResolvedValue();

    // Mock fetch for the Anthropic provider
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Hello!" }],
        usage: { input_tokens: 1000, output_tokens: 500 },
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      }),
    }) as unknown as typeof fetch;

    const request: AgentRequest = {
      task_id: "task-cost-test",
      prompt: "Calculate this.",
      context: {},
      constraints: { max_tokens: 1000, timeout_ms: 5000 },
    };

    const result = await execute("test-agent-cost", request, 0);

    // cost = (1000/1000 * 0.25) + (500/1000 * 1.25) = 0.25 + 0.625 = 0.875
    expect(result.outcome).toBe("SUCCESS");
    expect(result.cost_usd).toBeCloseTo(0.875, 5);
    expect(result.input_tokens).toBe(1000);
    expect(result.output_tokens).toBe(500);

    findByIdSpy.mockRestore();
    insertSpy.mockRestore();
  });

  it("throws when agent is not found", async () => {
    const agentRegistryMod =
      await import("../../src/repositories/agent-registry.js");
    const findByIdSpy = vi
      .spyOn(agentRegistryMod, "findById")
      .mockResolvedValue(null);

    const request: AgentRequest = {
      task_id: "task-not-found",
      prompt: "Hello",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000 },
    };

    await expect(execute("nonexistent-agent", request)).rejects.toThrow(
      "Agent not found",
    );

    findByIdSpy.mockRestore();
  });

  it("retry on failure: fail twice then succeed produces 3 records", async () => {
    const agentRegistryMod =
      await import("../../src/repositories/agent-registry.js");
    const findByIdSpy = vi
      .spyOn(agentRegistryMod, "findById")
      .mockResolvedValue({
        agent_id: "test-agent-retry",
        provider: "anthropic",
        model_id: "claude-haiku-4-5-20251001",
        capabilities: ["summarization"],
        cost_per_1k_input: 0.001,
        cost_per_1k_output: 0.005,
        max_context_tokens: 100000,
        avg_latency_ms: 200,
        status: "active",
        tier_ceiling: 2,
      });

    const insertedRecords: unknown[] = [];
    const insertSpy = vi
      .spyOn(execRepo, "insertExecution")
      .mockImplementation(async (record) => {
        insertedRecords.push(record);
      });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error("Connection refused");
      }
      return {
        ok: true,
        json: async () => ({
          content: [{ text: "Finally!" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
        }),
      };
    }) as unknown as typeof fetch;

    const request: AgentRequest = {
      task_id: "task-retry-test",
      prompt: "Retry me.",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000 },
    };

    // Use maxRetries=2, so up to 3 attempts. We fail 2, succeed on 3.
    // Override backoff by mocking setTimeout to be near-instant
    const origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, _ms?: number) =>
      origSetTimeout(fn, 0),
    );

    try {
      const result = await execute("test-agent-retry", request, 2);
      expect(result.outcome).toBe("SUCCESS");
      expect(result.response_content).toBe("Finally!");
      expect(insertedRecords.length).toBe(3);

      // First two should be FALLBACK
      expect((insertedRecords[0] as { outcome: string }).outcome).toBe(
        "FALLBACK",
      );
      expect((insertedRecords[1] as { outcome: string }).outcome).toBe(
        "FALLBACK",
      );
      // Third should be SUCCESS
      expect((insertedRecords[2] as { outcome: string }).outcome).toBe(
        "SUCCESS",
      );
    } finally {
      vi.stubGlobal("setTimeout", origSetTimeout);
      findByIdSpy.mockRestore();
      insertSpy.mockRestore();
    }
  });

  it("all retries exhausted: final outcome is ERROR", async () => {
    const agentRegistryMod =
      await import("../../src/repositories/agent-registry.js");
    const findByIdSpy = vi
      .spyOn(agentRegistryMod, "findById")
      .mockResolvedValue({
        agent_id: "test-agent-exhaust",
        provider: "anthropic",
        model_id: "claude-haiku-4-5-20251001",
        capabilities: ["summarization"],
        cost_per_1k_input: 0.001,
        cost_per_1k_output: 0.005,
        max_context_tokens: 100000,
        avg_latency_ms: 200,
        status: "active",
        tier_ceiling: 2,
      });

    const insertedRecords: unknown[] = [];
    const insertSpy = vi
      .spyOn(execRepo, "insertExecution")
      .mockImplementation(async (record) => {
        insertedRecords.push(record);
      });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("Connection refused"),
      ) as unknown as typeof fetch;

    const request: AgentRequest = {
      task_id: "task-exhaust-test",
      prompt: "Fail me.",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000 },
    };

    const origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, _ms?: number) =>
      origSetTimeout(fn, 0),
    );

    try {
      const result = await execute("test-agent-exhaust", request, 2);
      expect(result.outcome).toBe("ERROR");
      expect(result.error_detail).toBe("Connection refused");
      expect(insertedRecords.length).toBe(3);

      // First two FALLBACK, last one ERROR
      expect((insertedRecords[0] as { outcome: string }).outcome).toBe(
        "FALLBACK",
      );
      expect((insertedRecords[1] as { outcome: string }).outcome).toBe(
        "FALLBACK",
      );
      expect((insertedRecords[2] as { outcome: string }).outcome).toBe("ERROR");
    } finally {
      vi.stubGlobal("setTimeout", origSetTimeout);
      findByIdSpy.mockRestore();
      insertSpy.mockRestore();
    }
  });

  it("all retries exhausted with TIMEOUT: final outcome is TIMEOUT", async () => {
    const agentRegistryMod =
      await import("../../src/repositories/agent-registry.js");
    const findByIdSpy = vi
      .spyOn(agentRegistryMod, "findById")
      .mockResolvedValue({
        agent_id: "test-agent-timeout",
        provider: "anthropic",
        model_id: "claude-haiku-4-5-20251001",
        capabilities: ["summarization"],
        cost_per_1k_input: 0.001,
        cost_per_1k_output: 0.005,
        max_context_tokens: 100000,
        avg_latency_ms: 200,
        status: "active",
        tier_ceiling: 2,
      });

    const insertedRecords: unknown[] = [];
    const insertSpy = vi
      .spyOn(execRepo, "insertExecution")
      .mockImplementation(async (record) => {
        insertedRecords.push(record);
      });

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("TIMEOUT")) as unknown as typeof fetch;

    const request: AgentRequest = {
      task_id: "task-timeout-test",
      prompt: "Timeout me.",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 50 },
    };

    const origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, _ms?: number) =>
      origSetTimeout(fn, 0),
    );

    try {
      const result = await execute("test-agent-timeout", request, 1);
      expect(result.outcome).toBe("TIMEOUT");
      expect(insertedRecords.length).toBe(2);
    } finally {
      vi.stubGlobal("setTimeout", origSetTimeout);
      findByIdSpy.mockRestore();
      insertSpy.mockRestore();
    }
  });
});

// --- Integration tests (require Dolt) ---

let doltAvailable = false;
const testPrefix = `test-exec-${Date.now()}`;

beforeAll(async () => {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }
  try {
    await query("SELECT 1");
    doltAvailable = true;
    await runMigrations();
  } catch {
    console.warn("Dolt not available — skipping integration tests");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM execution_log WHERE task_id LIKE 'test-%'");
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'test-%'");
  }
  await destroy();
});

describe("execution service — integration tests", () => {
  it("successful execution records to execution_log", async ({ skip }) => {
    if (!doltAvailable) skip();

    // Seed a test agent
    const agentId = `${testPrefix}-integ`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO agent_registry
         (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        "anthropic",
        "claude-haiku-4-5-20251001",
        JSON.stringify(["summarization"]),
        0.25,
        1.25,
        200000,
        500,
        "active",
        2,
      ],
    );

    // Mock fetch for the Anthropic provider
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Integration test response" }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      }),
    }) as unknown as typeof fetch;

    const taskId = `test-task-${Date.now()}`;
    const request: AgentRequest = {
      task_id: taskId,
      prompt: "Integration test prompt.",
      context: {},
      constraints: { max_tokens: 200, timeout_ms: 5000 },
    };

    const result = await execute(agentId, request, 0);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.response_content).toBe("Integration test response");

    // Verify the row was persisted
    const rows = await execRepo.findByTaskId(taskId);
    expect(rows.length).toBe(1);
    expect(rows[0].execution_id).toBe(result.execution_id);
    expect(rows[0].agent_id).toBe(agentId);
    expect(rows[0].outcome).toBe("SUCCESS");
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(50);
    // cost = (100/1000 * 0.25) + (50/1000 * 1.25) = 0.025 + 0.0625 = 0.0875
    expect(rows[0].cost_usd).toBeCloseTo(0.0875, 4);
  });
});
