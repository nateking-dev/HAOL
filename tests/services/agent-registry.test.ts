import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, query, destroy } from "../../src/db/connection.js";
import { loadConfig } from "../../src/config.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as svc from "../../src/services/agent-registry.js";
import type { CreateAgentInput } from "../../src/types/agent.js";

let doltAvailable = false;
const testPrefix = `test-svc-${Date.now()}`;

function makeAgent(suffix: string, overrides?: Partial<CreateAgentInput>): CreateAgentInput {
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

describe("agent-registry service", () => {
  it("createAgent with valid capabilities succeeds", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("create-valid");
    const agent = await svc.createAgent(input);
    expect(agent.agent_id).toBe(input.agent_id);
    expect(agent.capabilities).toEqual(["summarization", "classification"]);
    expect(agent.status).toBe("active");
  });

  it("createAgent with unknown capability throws", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("create-bad-cap", {
      capabilities: ["summarization", "totally_fake_capability"],
    });

    await expect(svc.createAgent(input)).rejects.toThrow("Unknown capabilities");
  });

  it("getAgent returns the created agent", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("get");
    await svc.createAgent(input);

    const agent = await svc.getAgent(input.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.agent_id).toBe(input.agent_id);
  });

  it("listAgents returns agents", async ({ skip }) => {
    if (!doltAvailable) skip();

    const agents = await svc.listAgents();
    expect(agents.length).toBeGreaterThan(0);
  });

  it("deleteAgent sets status to disabled", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("delete");
    await svc.createAgent(input);

    await svc.deleteAgent(input.agent_id);

    const agent = await svc.getAgent(input.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.status).toBe("disabled");
  });

  it("updateAgent changes specified fields", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("update");
    await svc.createAgent(input);

    const updated = await svc.updateAgent(input.agent_id, {
      avg_latency_ms: 555,
    });
    expect(updated).not.toBeNull();
    expect(updated!.avg_latency_ms).toBe(555);
  });

  it("findAgentsByCapabilities returns matching active agents", async ({ skip }) => {
    if (!doltAvailable) skip();

    const input = makeAgent("caps-search", {
      capabilities: ["summarization", "classification"],
    });
    await svc.createAgent(input);

    const found = await svc.findAgentsByCapabilities(["summarization", "classification"]);
    expect(found.some((a) => a.agent_id === input.agent_id)).toBe(true);
  });
});
