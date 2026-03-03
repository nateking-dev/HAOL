import { z } from "zod";

export const ScoredCandidate = z.object({
  agent_id: z.string(),
  capability_score: z.number(),
  cost_score: z.number(),
  latency_score: z.number(),
  total_score: z.number(),
});
export type ScoredCandidate = z.infer<typeof ScoredCandidate>;

export const SelectionResult = z.object({
  selected_agent_id: z.string(),
  scored_candidates: z.array(ScoredCandidate),
  rationale: z.object({
    capability_score: z.number(),
    cost_score: z.number(),
    latency_score: z.number(),
    total_score: z.number(),
  }),
  fallback_applied: z.enum(["NONE", "NEXT_BEST", "TIER_UP"]),
});
export type SelectionResult = z.infer<typeof SelectionResult>;

export const RoutingPolicy = z.object({
  policy_id: z.string(),
  weight_capability: z.number(),
  weight_cost: z.number(),
  weight_latency: z.number(),
  fallback_strategy: z.enum(["NEXT_BEST", "TIER_UP", "ABORT"]),
  max_retries: z.number(),
  active: z.boolean(),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;
