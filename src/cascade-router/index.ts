// Core types
export type {
  TierId,
  TierDefinition,
  RoutingRule,
  ReferenceUtterance,
  RouterConfig,
  RoutingRequest,
  RoutingDecision,
  SimilarityMatch,
  RoutingLayer,
  RuleType,
  EmbeddingProvider,
  EscalationProvider,
} from "./types.js";

// Router
export { CascadeRouter } from "./cascade-router.js";
export type { CascadeRouterOpts } from "./cascade-router.js";

// Classify wrapper
export { classifyCascade, resetCascadeRouter } from "./classify.js";

// Data access
export {
  loadRules,
  loadUtterances,
  loadConfig,
  logDecision,
  hasEmbeddings,
} from "./reference-store.js";

// Embedding providers
export { OpenAIEmbeddingProvider } from "./embedding-openai.js";
export { createEmbeddingProvider } from "./embedding.js";

// Escalation provider
export { AnthropicEscalationProvider } from "./escalation.js";

// Similarity utils
export { cosineSimilarity, rankBySimilarity, weightedTierVote } from "./similarity.js";
