import { describe, it, expect, beforeEach, vi } from "vitest";

const createAgentMock = vi.fn();
const updateAgentMock = vi.fn();
const deleteAgentMock = vi.fn();
const getAgentMock = vi.fn();
const listAgentsMock = vi.fn();

vi.mock("../../src/services/agent-registry.js", () => ({
  createAgent: (...args: unknown[]) => createAgentMock(...args),
  updateAgent: (...args: unknown[]) => updateAgentMock(...args),
  deleteAgent: (...args: unknown[]) => deleteAgentMock(...args),
  getAgent: (...args: unknown[]) => getAgentMock(...args),
  listAgents: (...args: unknown[]) => listAgentsMock(...args),
}));

import { createApp } from "../../src/api/app.js";

describe("agent API request body handling", () => {
  beforeEach(() => {
    createAgentMock.mockReset();
    updateAgentMock.mockReset();
    deleteAgentMock.mockReset();
    getAgentMock.mockReset();
    listAgentsMock.mockReset();
  });

  it("returns 400 for malformed JSON on POST /agents", async () => {
    const app = createApp();

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON request body" });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON on PUT /agents/:id", async () => {
    const app = createApp();

    const res = await app.request("/v1/agents/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON request body" });
    expect(getAgentMock).not.toHaveBeenCalled();
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it("returns 400 when updating an agent to unknown capabilities", async () => {
    getAgentMock.mockResolvedValue({
      agent_id: "agent-1",
      provider: "local",
      model_id: "test",
      capabilities: ["summarization"],
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      max_context_tokens: 4096,
      avg_latency_ms: 100,
      status: "active",
      tier_ceiling: 1,
    });
    updateAgentMock.mockRejectedValue(new Error("Unknown capabilities: fake_capability"));
    const app = createApp();

    const res = await app.request("/v1/agents/agent-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: ["fake_capability"] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown capabilities: fake_capability" });
  });
});
