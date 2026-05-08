import { describe, it, expect, vi, afterEach } from "vitest";
import { _tryFallbackAgentForTests } from "../../src/router/router.js";
import * as agentSelection from "../../src/services/agent-selection.js";
import { logger } from "../../src/logging/logger.js";
import type { TaskClassification } from "../../src/types/task.js";
import type { RoutingPolicy, SelectionResult, ScoredCandidate } from "../../src/types/selection.js";

function classification(tier: 1 | 2 | 3 | 4): TaskClassification {
  return {
    task_id: "t-fallback",
    prompt_hash: "deadbeef",
    complexity_tier: tier,
    required_capabilities: ["summarization"],
    cost_ceiling_usd: 0.05,
    routing_layer: "deterministic",
    routing_confidence: 1,
  };
}

function candidate(agent_id: string, total_score = 0.5): ScoredCandidate {
  return {
    agent_id,
    capability_score: 1,
    cost_score: 1,
    latency_score: 1,
    total_score,
  };
}

function selectionResult(winner: string, ranked: string[]): SelectionResult {
  return {
    selected_agent_id: winner,
    scored_candidates: ranked.map((id, i) => candidate(id, 1 - i * 0.1)),
    rationale: { capability_score: 1, cost_score: 1, latency_score: 1, total_score: 1 },
    fallback_applied: "NONE",
  };
}

const policy = (strategy: "NEXT_BEST" | "TIER_UP" | "ABORT"): RoutingPolicy => ({
  policy_id: "test",
  weight_capability: 0.5,
  weight_cost: 0.3,
  weight_latency: 0.2,
  fallback_strategy: strategy,
  max_retries: 2,
  active: true,
  weight_outcome: 0,
});

describe("tryFallbackAgent — policy-aware behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("undefined policy: implicit NEXT_BEST — consumes ranking without calling select()", async () => {
    const selectSpy = vi.spyOn(agentSelection, "select");
    const sel = selectionResult("agent-a", ["agent-a", "agent-b"]);

    const result = await _tryFallbackAgentForTests(classification(2), sel, "agent-a", undefined);

    expect(result).toEqual({ agent_id: "agent-b" });
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("ABORT: returns null without consulting scored_candidates or select()", async () => {
    const selectSpy = vi.spyOn(agentSelection, "select");
    const sel = selectionResult("agent-a", ["agent-a", "agent-b", "agent-c"]);

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("ABORT"),
    );

    expect(result).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("NEXT_BEST: consumes existing scored_candidates without re-running select()", async () => {
    const selectSpy = vi.spyOn(agentSelection, "select");
    const sel = selectionResult("agent-a", ["agent-a", "agent-b", "agent-c"]);

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("NEXT_BEST"),
    );

    expect(result).toEqual({ agent_id: "agent-b" });
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("NEXT_BEST: returns null when no other ranked candidate exists", async () => {
    const sel = selectionResult("agent-a", ["agent-a"]);

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("NEXT_BEST"),
    );

    expect(result).toBeNull();
  });

  it("TIER_UP: re-runs select() against complexity_tier+1 with bumped cost ceiling", async () => {
    const sel = selectionResult("agent-haiku", ["agent-haiku"]);
    const selectSpy = vi.spyOn(agentSelection, "select").mockResolvedValueOnce({
      selected_agent_id: "agent-sonnet",
      scored_candidates: [candidate("agent-sonnet")],
      rationale: { capability_score: 1, cost_score: 1, latency_score: 1, total_score: 1 },
      fallback_applied: "NONE",
    });

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-haiku",
      policy("TIER_UP"),
    );

    expect(result).toEqual({ agent_id: "agent-sonnet" });
    expect(selectSpy).toHaveBeenCalledOnce();
    const escalated = selectSpy.mock.calls[0][0] as TaskClassification;
    expect(escalated.complexity_tier).toBe(3);
    // T3 ceiling per costCeilingForTier
    expect(escalated.cost_ceiling_usd).toBe(0.5);
  });

  it("TIER_UP at T4 with no other ranked candidate: logs a warning and returns null", async () => {
    const selectSpy = vi.spyOn(agentSelection, "select");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sel = selectionResult("agent-a", ["agent-a"]);

    const result = await _tryFallbackAgentForTests(
      classification(4),
      sel,
      "agent-a",
      policy("TIER_UP"),
    );

    expect(result).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIER_UP requested but task already at top tier"),
      expect.objectContaining({ complexity_tier: 4 }),
    );
  });

  it("TIER_UP at T4: skips escalation, logs a warning, and falls through to NEXT_BEST", async () => {
    const selectSpy = vi.spyOn(agentSelection, "select");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sel = selectionResult("agent-a", ["agent-a", "agent-b"]);

    const result = await _tryFallbackAgentForTests(
      classification(4),
      sel,
      "agent-a",
      policy("TIER_UP"),
    );

    expect(result).toEqual({ agent_id: "agent-b" });
    expect(selectSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIER_UP requested but task already at top tier"),
      expect.objectContaining({ complexity_tier: 4 }),
    );
  });

  it("TIER_UP: when escalated select() throws, logs a warning and falls through to NEXT_BEST", async () => {
    const selectSpy = vi
      .spyOn(agentSelection, "select")
      .mockRejectedValueOnce(new Error("no agent at T3"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sel = selectionResult("agent-a", ["agent-a", "agent-b"]);

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("TIER_UP"),
    );

    expect(result).toEqual({ agent_id: "agent-b" });
    expect(selectSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIER_UP escalation failed"),
      expect.objectContaining({
        from_tier: 2,
        to_tier: 3,
        error: "no agent at T3",
      }),
    );
  });

  it("TIER_UP: when higher-tier select() returns only the excluded agent, logs a warning and falls through", async () => {
    const sel = selectionResult("agent-a", ["agent-a", "agent-b"]);
    vi.spyOn(agentSelection, "select").mockResolvedValueOnce({
      selected_agent_id: "agent-a",
      scored_candidates: [candidate("agent-a")],
      rationale: { capability_score: 1, cost_score: 1, latency_score: 1, total_score: 1 },
      fallback_applied: "NONE",
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("TIER_UP"),
    );

    expect(result).toEqual({ agent_id: "agent-b" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TIER_UP escalation produced no alternative"),
      expect.objectContaining({ from_tier: 2, to_tier: 3 }),
    );
  });

  it("TIER_UP: when higher-tier returns a different second-best (excluded primary still leads at higher tier)", async () => {
    const sel = selectionResult("agent-a", ["agent-a"]);
    vi.spyOn(agentSelection, "select").mockResolvedValueOnce({
      selected_agent_id: "agent-a",
      scored_candidates: [candidate("agent-a"), candidate("agent-c")],
      rationale: { capability_score: 1, cost_score: 1, latency_score: 1, total_score: 1 },
      fallback_applied: "NONE",
    });

    const result = await _tryFallbackAgentForTests(
      classification(2),
      sel,
      "agent-a",
      policy("TIER_UP"),
    );

    expect(result).toEqual({ agent_id: "agent-c" });
  });
});
