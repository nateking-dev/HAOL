import { z } from "zod";
import type { ComplexityTier } from "../types/task.js";

// Re-export for convenience
export type TierId = ComplexityTier;

export type RoutingLayer = "deterministic" | "semantic" | "escalation" | "fallback";
export type RuleType = "regex" | "prefix" | "contains" | "metadata";

export interface TierDefinition {
  tier_id: TierId;
  tier_name: string;
  description: string | null;
  default_agent: string;
}

export interface RoutingRule {
  rule_id: string;
  tier_id: TierId;
  rule_type: RuleType;
  pattern: string;
  capabilities: string[] | null;
  priority: number;
  enabled: boolean;
  description: string | null;
}

export interface ReferenceUtterance {
  utterance_id: string;
  tier_id: TierId;
  utterance_text: string;
  embedding: number[];
}

export interface RouterConfig {
  embedding_model: string;
  embedding_dimensions: number;
  similarity_threshold: number;
  escalation_threshold: number;
  escalation_model: string;
  default_tier: TierId;
  top_k: number;
  enable_escalation: boolean;
  confidence_threshold: number;
}

export interface RoutingRequest {
  prompt: string;
  metadata?: {
    tier?: TierId;
    capabilities?: string[];
  };
}

export interface RoutingDecision {
  tier: TierId;
  capabilities: string[];
  layer: RoutingLayer;
  confidence: number;
  similarity_score?: number;
  latency_ms: number;
}

export type LayerAttemptStatus = "matched" | "missed" | "skipped" | "error";

export interface LayerAttempt {
  layer: RoutingLayer;
  status: LayerAttemptStatus;
  confidence: number | null;
  similarity_score: number | null;
  latency_ms: number;
  tier: TierId | null;
  reason: string;
}

export interface CascadeTrace {
  layers: LayerAttempt[];
  resolved_layer: RoutingLayer;
  total_latency_ms: number;
}

export const LayerAttemptSchema = z.object({
  layer: z.enum(["deterministic", "semantic", "escalation", "fallback"]),
  status: z.enum(["matched", "missed", "skipped", "error"]),
  confidence: z.number().nullable(),
  similarity_score: z.number().nullable(),
  latency_ms: z.number(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
  reason: z.string(),
});

export const CascadeTraceSchema = z.object({
  layers: z.array(LayerAttemptSchema),
  resolved_layer: z.enum(["deterministic", "semantic", "escalation", "fallback"]),
  total_latency_ms: z.number(),
});

export function skippedAttempt(layer: RoutingLayer, reason: string): LayerAttempt {
  return {
    layer,
    status: "skipped",
    confidence: null,
    similarity_score: null,
    latency_ms: 0,
    tier: null,
    reason,
  };
}

export interface SimilarityMatch {
  utterance_id: string;
  tier_id: TierId;
  score: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  modelId(): string;
  dimensions(): number;
}

export interface EscalationProvider {
  classify(
    prompt: string,
    tiers: TierDefinition[],
  ): Promise<{ tier: TierId; capabilities: string[]; confidence: number }>;
}
