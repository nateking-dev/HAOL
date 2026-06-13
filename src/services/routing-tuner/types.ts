import type { TierId } from "../../cascade-router/types.js";

// ---------------------------------------------------------------------------
// Shared types for the routing tuner
// ---------------------------------------------------------------------------

export interface TuneOptions {
  /** Hours of outcome history to analyze (default: 72) */
  hours: number;
  /** Minimum tasks per agent+tier combo before acting (default: 5) */
  minSampleSize: number;
  /** Only crystallize rules from patterns seen >= this many times (default: 3) */
  minPatternFrequency: number;
  /** Confidence threshold — only crystallize LLM classifications above this (default: 0.8) */
  crystallizeConfidenceThreshold: number;
  /** If true, compute adjustments but don't write them */
  dryRun: boolean;
}

export interface AgentTierOutcome {
  agent_id: string;
  complexity_tier: number;
  positive: number;
  negative: number;
  total: number;
  success_rate: number;
}

export interface CrystallizedRule {
  tier_id: TierId;
  pattern: string;
  rule_type: "contains";
  capabilities: string[];
  source_task_count: number;
}

export interface PromotedUtterance {
  tier_id: TierId;
  utterance_text: string;
  source_task_id: string;
}

export interface TuneResult {
  run_id: string;
  status: "completed" | "dry_run";
  hours_window: number;
  tasks_analyzed: number;
  signals_used: number;
  agent_tier_outcomes: AgentTierOutcome[];
  rules_created: CrystallizedRule[];
  utterances_added: PromotedUtterance[];
  actionable_agent_tier_combos: number;
}

export interface TuningRunSummary {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  hours_window: number;
  tasks_analyzed: number;
  signals_used: number;
  rules_created: number;
  utterances_added: number;
  actionable_agent_tier_combos: number;
}
