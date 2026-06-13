import { query } from "../../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { AgentTierOutcome, TuningRunSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape SQL LIKE metacharacters so they match literally. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Aggregate outcome signals
// ---------------------------------------------------------------------------

interface AgentTierOutcomeRow extends RowDataPacket {
  agent_id: string;
  complexity_tier: number;
  positive: number | string;
  negative: number | string;
  total: number | string;
}

/**
 * Aggregates outcome signals per agent per complexity tier.
 * Uses per-task aggregation first (MIN signal_value — worst signal wins)
 * to avoid skewing metrics when a single task has multiple signals that
 * disagree (e.g. clean_execution=1 but json_valid=0).
 */
export async function aggregateOutcomesByAgentTier(hours: number): Promise<AgentTierOutcome[]> {
  const rows = await query<AgentTierOutcomeRow[]>(
    `SELECT
       agent_id,
       complexity_tier,
       SUM(CASE WHEN task_signal = 1 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN task_signal = 0 THEN 1 ELSE 0 END) AS negative,
       COUNT(*) AS total
     FROM (
       SELECT
         t.selected_agent_id AS agent_id,
         t.complexity_tier,
         MIN(o.signal_value) AS task_signal
       FROM task_outcome o
       JOIN task_log t ON t.task_id = o.task_id
       WHERE o.signal_value IS NOT NULL
         AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND t.selected_agent_id IS NOT NULL
         AND t.complexity_tier IS NOT NULL
       GROUP BY t.selected_agent_id, t.complexity_tier, o.task_id
     ) per_task
     GROUP BY agent_id, complexity_tier
     ORDER BY agent_id, complexity_tier`,
    [hours],
  );

  return rows.map((r) => {
    const positive = typeof r.positive === "string" ? parseInt(r.positive, 10) : Number(r.positive);
    const negative = typeof r.negative === "string" ? parseInt(r.negative, 10) : Number(r.negative);
    const total = typeof r.total === "string" ? parseInt(r.total, 10) : Number(r.total);
    return {
      agent_id: r.agent_id,
      complexity_tier: r.complexity_tier,
      positive,
      negative,
      total,
      success_rate: total > 0 ? positive / total : 0,
    };
  });
}

/** Counts the distinct tasks that produced a non-null outcome signal in the window. */
export async function countTasksAnalyzed(hours: number): Promise<number> {
  interface TaskCountRow extends RowDataPacket {
    cnt: number | string;
  }
  const rows = await query<TaskCountRow[]>(
    `SELECT COUNT(DISTINCT t.task_id) AS cnt
     FROM task_outcome o
     JOIN task_log t ON t.task_id = o.task_id
     WHERE o.signal_value IS NOT NULL
       AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [hours],
  );
  return typeof rows[0]?.cnt === "string" ? parseInt(rows[0].cnt, 10) : Number(rows[0]?.cnt ?? 0);
}

// ---------------------------------------------------------------------------
// Find LLM escalation patterns to crystallize
// ---------------------------------------------------------------------------

export interface EscalationPatternRow extends RowDataPacket {
  routed_tier: number;
  input_text: string;
  confidence: number;
  task_id: string;
}

/**
 * Finds tasks that were classified by the LLM escalation layer (Layer 2)
 * and had successful outcomes — candidates for crystallization into
 * deterministic rules.
 */
export async function findSuccessfulEscalations(
  hours: number,
  confidenceThreshold: number,
): Promise<EscalationPatternRow[]> {
  const rows = await query<EscalationPatternRow[]>(
    `SELECT rl.routed_tier, rl.input_text, rl.confidence, t.task_id
     FROM routing_log rl
     JOIN task_log t ON t.task_id = rl.request_id
     WHERE rl.routing_layer = 'escalation'
       AND rl.confidence >= ?
       AND rl.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND t.status = 'COMPLETED'
       AND EXISTS (
         SELECT 1 FROM task_outcome o
         WHERE o.task_id = t.task_id
           AND o.signal_value = 1
       )
     ORDER BY rl.created_at DESC
     LIMIT 500`,
    [confidenceThreshold, hours],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Find successful tasks routed by the fallback layer
// ---------------------------------------------------------------------------

export interface FallbackSuccessRow extends RowDataPacket {
  task_id: string;
  routed_tier: number;
  input_text: string;
}

/**
 * Finds tasks that fell through to the fallback layer (no rules, no
 * embeddings matched) but still completed successfully. These are good
 * candidates for new reference utterances.
 */
export async function findSuccessfulFallbacks(hours: number): Promise<FallbackSuccessRow[]> {
  const rows = await query<FallbackSuccessRow[]>(
    `SELECT rl.request_id AS task_id, rl.routed_tier, rl.input_text
     FROM routing_log rl
     JOIN task_log t ON t.task_id = rl.request_id
     WHERE rl.routing_layer = 'fallback'
       AND rl.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND t.status = 'COMPLETED'
       AND EXISTS (
         SELECT 1 FROM task_outcome o
         WHERE o.task_id = t.task_id
           AND o.signal_value = 1
       )
     ORDER BY rl.created_at DESC
     LIMIT 100`,
    [hours],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Existing-rule / existing-utterance lookups (de-duplication)
// ---------------------------------------------------------------------------

interface ExistingRuleRow extends RowDataPacket {
  tier_id: number;
  pattern: string;
}

/** Returns enabled "contains" rules keyed as `tier:pattern` (pattern lowercased). */
export async function existingContainsPatterns(): Promise<Set<string>> {
  const rows = await query<ExistingRuleRow[]>(
    `SELECT tier_id, pattern FROM routing_rules WHERE rule_type = 'contains' AND enabled = TRUE`,
  );
  // Key by tier:pattern so the same phrase can exist at different tiers
  return new Set(rows.map((r) => `${r.tier_id}:${r.pattern.toLowerCase()}`));
}

/** Returns the subset of `texts` that already exist as routing utterances. */
export async function findExistingUtterances(texts: string[]): Promise<Set<string>> {
  if (texts.length === 0) return new Set();
  interface UtteranceTextRow extends RowDataPacket {
    utterance_text: string;
  }
  const placeholders = texts.map(() => "?").join(", ");
  const rows = await query<UtteranceTextRow[]>(
    `SELECT utterance_text FROM routing_utterances WHERE utterance_text IN (${placeholders})`,
    texts,
  );
  return new Set(rows.map((r) => r.utterance_text));
}

/**
 * Looks up the distinct capabilities required by tasks whose escalation
 * input matched `phrase` at the given tier. Used to seed a crystallized rule.
 */
export async function lookupCapabilitiesForPattern(
  tier: number,
  phrase: string,
): Promise<string[]> {
  const rows = await query<(RowDataPacket & { required_capabilities: string | null })[]>(
    `SELECT DISTINCT t.required_capabilities
     FROM task_log t
     JOIN routing_log rl ON rl.request_id = t.task_id
     WHERE rl.routing_layer = 'escalation'
       AND rl.routed_tier = ?
       AND LOWER(rl.input_text) LIKE ?
       AND t.required_capabilities IS NOT NULL
     LIMIT 5`,
    [tier, `%${escapeLike(phrase)}%`],
  );

  const capabilities = new Set<string>();
  for (const row of rows) {
    if (row.required_capabilities) {
      try {
        const parsed: string[] =
          typeof row.required_capabilities === "string"
            ? JSON.parse(row.required_capabilities)
            : row.required_capabilities;
        for (const cap of parsed) {
          capabilities.add(cap);
        }
      } catch {
        // Malformed JSON in required_capabilities — skip this row
      }
    }
  }
  return [...capabilities];
}

// ---------------------------------------------------------------------------
// Recent tuning runs (for CLI/API)
// ---------------------------------------------------------------------------

interface TuningRunRow extends RowDataPacket {
  run_id: string;
  started_at: string | Date;
  completed_at: string | Date | null;
  status: string;
  hours_window: number;
  tasks_analyzed: number;
  signals_used: number;
  rules_created: number;
  utterances_added: number;
  actionable_agent_tier_combos: number;
}

export async function recentTuningRuns(limit: number = 10): Promise<TuningRunSummary[]> {
  const rows = await query<TuningRunRow[]>(
    `SELECT run_id, started_at, completed_at, status, hours_window,
            tasks_analyzed, signals_used, rules_created, utterances_added,
            actionable_agent_tier_combos
     FROM tuning_run
     ORDER BY started_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    run_id: r.run_id,
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    completed_at: r.completed_at
      ? r.completed_at instanceof Date
        ? r.completed_at.toISOString()
        : String(r.completed_at)
      : null,
    status: r.status,
    hours_window: r.hours_window,
    tasks_analyzed: r.tasks_analyzed,
    signals_used: r.signals_used,
    rules_created: r.rules_created,
    utterances_added: r.utterances_added,
    actionable_agent_tier_combos: r.actionable_agent_tier_combos,
  }));
}
