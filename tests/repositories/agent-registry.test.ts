import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPool,
  getPool,
  query,
  destroy,
} from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as repo from "../../src/repositories/agent-registry.js";
import type { CreateAgentInput } from "../../src/types/agent.js";

let doltAvailable = false;
const testPrefix = `test-repo-${Date.now()}`;

function makeAgent(
  suffix: string,
  overrides?: Partial<CreateAgentInput>,
): CreateAgentInput {
  return {
    agent_id: `${testPrefix}-${suffix}`,
    provider: "test-provider",
    model_id: "test-model-v1",
    capabilities: ["summarization", "classification"],
    cost_per_1k_input: 0.001,
    cost_per_1k_output: 0.005,
    max_context_tokens: 100000,
    avg_latency_ms: 200,
    status: "active",
    tier_ceiling: 2,
    ...overrides,
  };
}

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
    console.warn("Dolt not available — skipping");
  }
});

afterAll(async () => {
  if (doltAvailable) {
    const pool = getPool();
    await pool.query("DELETE FROM agent_registry WHERE agent_id LIKE 'test-%'");
  }
  await destroy();
});

describe("agent-registry repository", () => {
  it("create + findById round-trip", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("roundtrip");
    await repo.create(input);

    const found = await repo.findById(input.agent_id);
    expect(found).not.toBeNull();
    expect(found!.agent_id).toBe(input.agent_id);
    expect(found!.provider).toBe("test-provider");
    expect(found!.capabilities).toEqual(["summarization", "classification"]);
    expect(typeof found!.cost_per_1k_input).toBe("number");
    expect(found!.cost_per_1k_input).toBeCloseTo(0.001, 5);
    expect(found!.status).toBe("active");
  });

  it("findById returns null for nonexistent agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    const found = await repo.findById("nonexistent-agent-xyz");
    expect(found).toBeNull();
  });

  it("findAll with status filter", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("status-filter", { status: "degraded" });
    await repo.create(input);

    const degraded = await repo.findAll({ status: "degraded" });
    expect(degraded.some((a) => a.agent_id === input.agent_id)).toBe(true);

    const active = await repo.findAll({ status: "active" });
    expect(active.some((a) => a.agent_id === input.agent_id)).toBe(false);
  });

  it("findByCapabilities returns matching agents", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("caps", {
      capabilities: ["summarization", "classification"],
    });
    await repo.create(input);

    const found = await repo.findByCapabilities(["summarization"]);
    expect(found.some((a) => a.agent_id === input.agent_id)).toBe(true);

    const found2 = await repo.findByCapabilities([
      "summarization",
      "classification",
    ]);
    expect(found2.some((a) => a.agent_id === input.agent_id)).toBe(true);

    const found3 = await repo.findByCapabilities(["vision"]);
    expect(found3.some((a) => a.agent_id === input.agent_id)).toBe(false);
  });

  it("update changes specified fields", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("update");
    await repo.create(input);

    await repo.update(input.agent_id, {
      avg_latency_ms: 999,
      status: "degraded",
    });

    const updated = await repo.findById(input.agent_id);
    expect(updated).not.toBeNull();
    expect(updated!.avg_latency_ms).toBe(999);
    expect(updated!.status).toBe("degraded");
    // Unchanged fields should remain
    expect(updated!.provider).toBe("test-provider");
  });

  it("remove sets status to disabled", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("remove");
    await repo.create(input);

    await repo.remove(input.agent_id);

    const found = await repo.findById(input.agent_id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("disabled");
  });
});
