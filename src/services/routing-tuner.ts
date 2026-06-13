// Public surface for the routing tuner. The implementation is split across
// the `routing-tuner/` directory by concern:
//   - types.ts           shared interfaces
//   - text-extraction.ts  keyword/stop-word extraction (pure)
//   - queries.ts          read-only data access
//   - lock.ts             advisory lock + tuning_run record lifecycle
//   - orchestrator.ts     the tune() pipeline + step helpers
export type {
  TuneOptions,
  AgentTierOutcome,
  CrystallizedRule,
  PromotedUtterance,
  TuneResult,
  TuningRunSummary,
} from "./routing-tuner/types.js";

export { extractKeyPhrases } from "./routing-tuner/text-extraction.js";
export {
  escapeLike,
  aggregateOutcomesByAgentTier,
  findSuccessfulEscalations,
  findSuccessfulFallbacks,
  recentTuningRuns,
} from "./routing-tuner/queries.js";
export { tune, DEFAULT_TUNE_OPTIONS } from "./routing-tuner/orchestrator.js";
