import { query, execute } from "../db/connection.js";
import { doltCommit } from "../db/dolt.js";
import { uuidv7 } from "../types/task.js";
import type { RowDataPacket } from "mysql2/promise";
import type { TierId } from "../cascade-router/types.js";

// ---------------------------------------------------------------------------
// Types
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

export const DEFAULT_TUNE_OPTIONS: TuneOptions = {
  hours: 72,
  minSampleSize: 5,
  minPatternFrequency: 3,
  crystallizeConfidenceThreshold: 0.8,
  dryRun: false,
};

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
  outcome_scores_updated: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape SQL LIKE metacharacters so they match literally. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Queries: aggregate outcome signals
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
 * Only considers tiers 0-3 signals with non-null signal_value.
 */
export async function aggregateOutcomesByAgentTier(
  hours: number,
): Promise<AgentTierOutcome[]> {
  const rows = await query<AgentTierOutcomeRow[]>(
    `SELECT
       t.selected_agent_id AS agent_id,
       t.complexity_tier,
       SUM(CASE WHEN o.signal_value = 1 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN o.signal_value = 0 THEN 1 ELSE 0 END) AS negative,
       COUNT(*) AS total
     FROM task_outcome o
     JOIN task_log t ON t.task_id = o.task_id
     WHERE o.signal_value IS NOT NULL
       AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND t.selected_agent_id IS NOT NULL
       AND t.complexity_tier IS NOT NULL
     GROUP BY t.selected_agent_id, t.complexity_tier
     ORDER BY t.selected_agent_id, t.complexity_tier`,
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

// ---------------------------------------------------------------------------
// Queries: find LLM escalation patterns to crystallize
// ---------------------------------------------------------------------------

interface EscalationPatternRow extends RowDataPacket {
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
       AND t.status = 'completed'
       AND EXISTS (
         SELECT 1 FROM task_outcome o
         WHERE o.task_id = t.task_id
           AND o.signal_value = 1
           AND o.tier IN (0, 1, 2, 3)
       )
     ORDER BY rl.created_at DESC
     LIMIT 500`,
    [confidenceThreshold, hours],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Queries: find successful tasks routed by fallback layer
// ---------------------------------------------------------------------------

interface FallbackSuccessRow extends RowDataPacket {
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
       AND t.status = 'completed'
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
// Rule crystallization: extract common keywords from LLM-classified prompts
// ---------------------------------------------------------------------------

/**
 * Extracts the most distinctive keyword from a prompt for use as a
 * "contains" routing rule. Strips stop words and picks the longest
 * remaining word that appears in at least `minFrequency` prompts.
 */
export function extractKeyPhrases(
  prompts: string[],
  minFrequency: number,
): Map<string, number> {
  const STOP_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "because", "but", "and", "or", "if", "while", "about", "this", "that",
    "these", "those", "it", "its", "i", "me", "my", "we", "our", "you",
    "your", "he", "she", "they", "them", "what", "which", "who", "whom",
    "please", "help", "want", "like", "make", "get", "give", "tell",
  ]);

  const wordCounts = new Map<string, number>();

  for (const prompt of prompts) {
    // Deduplicate words per prompt to count document frequency
    const words = new Set(
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
    );
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }

  // Filter to words appearing in >= minFrequency prompts
  const result = new Map<string, number>();
  for (const [word, count] of wordCounts) {
    if (count >= minFrequency) {
      result.set(word, count);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Check for existing rules to avoid duplicates
// ---------------------------------------------------------------------------

interface ExistingRuleRow extends RowDataPacket {
  pattern: string;
}

async function existingContainsPatterns(): Promise<Set<string>> {
  const rows = await query<ExistingRuleRow[]>(
    `SELECT pattern FROM routing_rules WHERE rule_type = 'contains' AND enabled = TRUE`,
  );
  return new Set(rows.map((r) => r.pattern.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Step helpers (extracted for readability and testability)
// ---------------------------------------------------------------------------

async function crystallizeRules(
  escalations: EscalationPatternRow[],
  options: TuneOptions,
): Promise<CrystallizedRule[]> {
  const crystallizedRules: CrystallizedRule[] = [];

  if (escalations.length < options.minPatternFrequency) {
    return crystallizedRules;
  }

  // Group by tier
  const byTier = new Map<number, string[]>();
  for (const e of escalations) {
    const list = byTier.get(e.routed_tier) ?? [];
    list.push(e.input_text);
    byTier.set(e.routed_tier, list);
  }

  const existingPatterns = await existingContainsPatterns();

  for (const [tier, prompts] of byTier) {
    if (prompts.length < options.minPatternFrequency) continue;

    const phrases = extractKeyPhrases(prompts, options.minPatternFrequency);

    // Take top 3 most frequent phrases per tier
    const sorted = [...phrases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    for (const [phrase, count] of sorted) {
      if (existingPatterns.has(phrase)) continue;

      // Look up capabilities from the tasks that matched
      const capRows = await query<(RowDataPacket & { required_capabilities: string | null })[]>(
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
      for (const row of capRows) {
        if (row.required_capabilities) {
          try {
            const parsed: string[] = typeof row.required_capabilities === "string"
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

      const rule: CrystallizedRule = {
        tier_id: tier as TierId,
        pattern: phrase,
        rule_type: "contains",
        capabilities: [...capabilities],
        source_task_count: count,
      };
      crystallizedRules.push(rule);

      if (!options.dryRun) {
        // INSERT IGNORE prevents duplicates if concurrent runs race
        await execute(
          `INSERT IGNORE INTO routing_rules
             (rule_id, tier_id, rule_type, pattern, capabilities, priority, enabled, description)
           VALUES (?, ?, 'contains', ?, ?, 200, TRUE, ?)`,
          [
            uuidv7(),
            tier,
            phrase,
            capabilities.size > 0 ? JSON.stringify([...capabilities]) : null,
            `Auto-crystallized from ${count} successful LLM escalations`,
          ],
        );
      }
    }
  }

  return crystallizedRules;
}

async function promoteUtterances(
  fallbacks: FallbackSuccessRow[],
  dryRun: boolean,
): Promise<PromotedUtterance[]> {
  const promotedUtterances: PromotedUtterance[] = [];
  const MAX_UTTERANCE_PROMOTIONS = 10;
  const candidates = fallbacks.slice(0, MAX_UTTERANCE_PROMOTIONS);

  if (candidates.length === 0) return promotedUtterances;

  // Batch check for existing utterances to avoid N+1 queries
  const candidateTexts = candidates.map((fb) => fb.input_text);
  const placeholders = candidateTexts.map(() => "?").join(", ");
  interface UtteranceTextRow extends RowDataPacket { utterance_text: string }
  const existingRows = await query<UtteranceTextRow[]>(
    `SELECT utterance_text FROM routing_utterances WHERE utterance_text IN (${placeholders})`,
    candidateTexts,
  );
  const existingTexts = new Set(existingRows.map((r) => r.utterance_text));

  for (const fb of candidates) {
    if (existingTexts.has(fb.input_text)) continue;

    // Truncate very long prompts — embeddings work best on concise text
    const text = fb.input_text.length > 512
      ? fb.input_text.slice(0, 512)
      : fb.input_text;

    promotedUtterances.push({
      tier_id: fb.routed_tier as TierId,
      utterance_text: text,
      source_task_id: fb.task_id,
    });

    if (!dryRun) {
      // Insert with 'pending' embedding — the embedding pipeline will
      // fill this in on next load (existing pattern from reference-store)
      await execute(
        `INSERT INTO routing_utterances
           (utterance_id, tier_id, utterance_text, embedding, embedding_model, embedding_dim, source)
         VALUES (?, ?, ?, '[]', 'pending', 0, 'tuner')`,
        [uuidv7(), fb.routed_tier, text],
      );
    }
  }

  return promotedUtterances;
}

// ---------------------------------------------------------------------------
// Main tuning function
// ---------------------------------------------------------------------------

export async function tune(opts: Partial<TuneOptions> = {}): Promise<TuneResult> {
  const options: TuneOptions = { ...DEFAULT_TUNE_OPTIONS, ...opts };
  const runId = uuidv7();

  // Guard against concurrent tuning runs
  if (!options.dryRun) {
    interface RunningRow extends RowDataPacket { run_id: string }
    const running = await query<RunningRow[]>(
      `SELECT run_id FROM tuning_run WHERE status = 'running' LIMIT 1`,
    );
    if (running.length > 0) {
      throw new Error(`Another tuning run is already in progress: ${running[0].run_id}`);
    }

    await execute(
      `INSERT INTO tuning_run (run_id, status, hours_window) VALUES (?, 'running', ?)`,
      [runId, options.hours],
    );
  }

  try {
    // ----- Step 1: Aggregate outcome signals per agent+tier -----
    const agentTierOutcomes = await aggregateOutcomesByAgentTier(options.hours);
    const totalSignals = agentTierOutcomes.reduce((sum, o) => sum + o.total, 0);

    interface TaskCountRow extends RowDataPacket { cnt: number | string }
    const taskCountRows = await query<TaskCountRow[]>(
      `SELECT COUNT(DISTINCT t.task_id) AS cnt
       FROM task_outcome o
       JOIN task_log t ON t.task_id = o.task_id
       WHERE o.signal_value IS NOT NULL
         AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [options.hours],
    );
    const tasksAnalyzed = typeof taskCountRows[0]?.cnt === "string"
      ? parseInt(taskCountRows[0].cnt, 10)
      : Number(taskCountRows[0]?.cnt ?? 0);

    // ----- Step 2: Crystallize LLM escalation patterns into rules -----
    const escalations = await findSuccessfulEscalations(
      options.hours,
      options.crystallizeConfidenceThreshold,
    );
    const crystallizedRules = await crystallizeRules(escalations, options);

    // ----- Step 3: Promote successful fallback prompts to utterances -----
    const fallbacks = await findSuccessfulFallbacks(options.hours);
    const promotedUtterances = await promoteUtterances(fallbacks, options.dryRun);

    // ----- Step 4: Count actionable outcome scores -----
    const actionableScores = agentTierOutcomes.filter(
      (o) => o.total >= options.minSampleSize,
    );

    // ----- Finalize -----
    const status: "completed" | "dry_run" = options.dryRun ? "dry_run" : "completed";

    const result: TuneResult = {
      run_id: runId,
      status,
      hours_window: options.hours,
      tasks_analyzed: tasksAnalyzed,
      signals_used: totalSignals,
      agent_tier_outcomes: agentTierOutcomes,
      rules_created: crystallizedRules,
      utterances_added: promotedUtterances,
      outcome_scores_updated: actionableScores.length,
    };

    if (!options.dryRun) {
      await execute(
        `UPDATE tuning_run
         SET status = ?, completed_at = NOW(),
             tasks_analyzed = ?, signals_used = ?,
             rules_created = ?, utterances_added = ?,
             outcome_scores_updated = ?,
             summary = ?
         WHERE run_id = ?`,
        [
          status,
          tasksAnalyzed,
          totalSignals,
          crystallizedRules.length,
          promotedUtterances.length,
          actionableScores.length,
          JSON.stringify({
            agent_tier_outcomes: agentTierOutcomes,
            rules_created: crystallizedRules.map((r) => ({
              pattern: r.pattern,
              tier: r.tier_id,
              task_count: r.source_task_count,
            })),
            utterances_added: promotedUtterances.length,
          }),
          runId,
        ],
      );

      try {
        const parts: string[] = [`tuner:${runId}`];
        if (crystallizedRules.length > 0) {
          parts.push(`rules:+${crystallizedRules.length}`);
        }
        if (promotedUtterances.length > 0) {
          parts.push(`utterances:+${promotedUtterances.length}`);
        }
        parts.push(`tasks:${tasksAnalyzed}`, `signals:${totalSignals}`);
        await doltCommit({
          message: parts.join(" | "),
          author: "haol-tuner <haol@system>",
        });
      } catch {
        // best-effort commit
      }
    }

    return result;
  } catch (err) {
    if (!options.dryRun) {
      try {
        await execute(
          `UPDATE tuning_run SET status = 'failed', completed_at = NOW(), error_message = ? WHERE run_id = ?`,
          [err instanceof Error ? err.message : "unknown", runId],
        );
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Query: recent tuning runs (for CLI/API)
// ---------------------------------------------------------------------------

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
  outcome_scores_updated: number;
}

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
  outcome_scores_updated: number;
}

export async function recentTuningRuns(limit: number = 10): Promise<TuningRunSummary[]> {
  const rows = await query<TuningRunRow[]>(
    `SELECT run_id, started_at, completed_at, status, hours_window,
            tasks_analyzed, signals_used, rules_created, utterances_added,
            outcome_scores_updated
     FROM tuning_run
     ORDER BY started_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    run_id: r.run_id,
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    completed_at: r.completed_at
      ? r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at)
      : null,
    status: r.status,
    hours_window: r.hours_window,
    tasks_analyzed: r.tasks_analyzed,
    signals_used: r.signals_used,
    rules_created: r.rules_created,
    utterances_added: r.utterances_added,
    outcome_scores_updated: r.outcome_scores_updated,
  }));
}
