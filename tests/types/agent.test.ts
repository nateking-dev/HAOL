import { describe, it, expect } from "vitest";
import {
  CreateAgentInput,
  UpdateAgentInput,
  AgentRegistration,
} from "../../src/types/agent.js";

describe("CreateAgentInput schema", () => {
  const validInput = {
    agent_id: "test-agent-1",
    provider: "anthropic",
    model_id: "claude-test",
    capabilities: ["summarization", "classification"],
    cost_per_1k_input: 0.001,
    cost_per_1k_output: 0.005,
    max_context_tokens: 100000,
    tier_ceiling: 2,
  };

  it("parses valid input correctly", () => {
    const result = CreateAgentInput.parse(validInput);
    expect(result.agent_id).toBe("test-agent-1");
    expect(result.provider).toBe("anthropic");
    expect(result.capabilities).toEqual(["summarization", "classification"]);
    expect(result.avg_latency_ms).toBe(0); // default
    expect(result.status).toBe("active"); // default
  });

  it("allows explicit avg_latency_ms and status", () => {
    const result = CreateAgentInput.parse({
      ...validInput,
      avg_latency_ms: 500,
      status: "degraded",
    });
    expect(result.avg_latency_ms).toBe(500);
    expect(result.status).toBe("degraded");
  });

  it("fails when required fields are missing", () => {
    expect(() => CreateAgentInput.parse({})).toThrow();
    expect(() => CreateAgentInput.parse({ agent_id: "x" })).toThrow();
    expect(() =>
      CreateAgentInput.parse({
        agent_id: "x",
        provider: "p",
        model_id: "m",
        // missing capabilities, costs, tokens, tier
      }),
    ).toThrow();
  });

  it("fails with invalid status value", () => {
    expect(() =>
      CreateAgentInput.parse({
        ...validInput,
        status: "unknown_status",
      }),
    ).toThrow();
  });

  it("requires capabilities to be a string array", () => {
    expect(() =>
      CreateAgentInput.parse({
        ...validInput,
        capabilities: "not-an-array",
      }),
    ).toThrow();

    expect(() =>
      CreateAgentInput.parse({
        ...validInput,
        capabilities: [1, 2, 3],
      }),
    ).toThrow();
  });
});

describe("UpdateAgentInput schema", () => {
  it("allows empty object (all fields optional)", () => {
    const result = UpdateAgentInput.parse({});
    expect(result).toEqual({});
  });

  it("allows partial updates", () => {
    const result = UpdateAgentInput.parse({ status: "degraded" });
    expect(result.status).toBe("degraded");
  });
});

describe("AgentRegistration schema", () => {
  it("parses a full agent row", () => {
    const result = AgentRegistration.parse({
      agent_id: "test-1",
      provider: "anthropic",
      model_id: "claude-test",
      capabilities: ["summarization"],
      cost_per_1k_input: 0.001,
      cost_per_1k_output: 0.005,
      max_context_tokens: 100000,
      avg_latency_ms: 300,
      status: "active",
      tier_ceiling: 2,
    });
    expect(result.agent_id).toBe("test-1");
  });
});
