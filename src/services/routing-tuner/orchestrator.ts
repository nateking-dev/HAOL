import { execute, getPool } from "../../db/connection.js";
import { doltCommit } from "../../db/dolt.js";
import { uuidv7 } from "../../types/task.js";
import type { ResultSetHeader } from "mysql2/promise";
import type { TierId } from "../../cascade-router/types.js";
import { logger } from "../../logging/logger.js";
import {
  aggregateOutcomesByAgentTier,
  countTasksAnalyzed,
  existingContainsPatterns,
  findExistingUtterances,
  findSuccessfulEscalations,
  findSuccessfulFallbacks,
  lookupCapabilitiesForPattern,
  type EscalationPatternRow,
  type FallbackSuccessRow,
} from "./queries.js";
import { extractKeyPhrases } from "./text-extraction.js";
import {
  acquireTunerLock,
  finalizeTuningRun,
  recordTunerFailure,
  releaseTunerLock,
} from "./lock.js";
import type { CrystallizedRule, PromotedUtterance, TuneOptions, TuneResult } from "./types.js";

const MIN_UTTERANCE_LENGTH = 20;

export const DEFAULT_TUNE_OPTIONS: TuneOptions = {
  hours: 72,
  minSampleSize: 5,
  minPatternFrequency: 3,
  crystallizeConfidenceThreshold: 0.8,
  dryRun: false,
};

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

async function crystallizeRules(
  escalations: EscalationPatternRow[],
  options: TuneOptions,
): Promise<CrystallizedRule[]> {
  const crystallizedRules: CrystallizedRule[] = [];

  // Need at least minPatternFrequency total escalations before it's
  // worth looking for repeated patterns within them.
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
      if (existingPatterns.has(`${tier}:${phrase}`)) continue;

      const capabilities = await lookupCapabilitiesForPattern(tier, phrase);

      const rule: CrystallizedRule = {
        tier_id: tier as TierId,
        pattern: phrase,
        rule_type: "contains",
        capabilities,
        source_task_count: count,
      };
      if (!options.dryRun) {
        // INSERT IGNORE prevents duplicates if concurrent runs race.
        // Only count the rule if it was actually inserted (affectedRows > 0).
        const pool = getPool();
        const [insertResult] = await pool.query<ResultSetHeader>(
          `INSERT IGNORE INTO routing_rules
             (rule_id, tier_id, rule_type, pattern, capabilities, priority, enabled, description)
           VALUES (?, ?, 'contains', ?, ?, 200, TRUE, ?)`,
          [
            uuidv7(),
            tier,
            phrase,
            capabilities.length > 0 ? JSON.stringify(capabilities) : null,
            `Auto-crystallized from ${count} successful LLM escalations`,
          ],
        );
        if (insertResult.affectedRows > 0) {
          crystallizedRules.push(rule);
        }
      } else {
        crystallizedRules.push(rule);
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

  // Truncate and filter: skip very short prompts that would pollute the
  // semantic layer, and cap at 512 chars for embedding quality.
  const truncated = candidates
    .filter((fb) => fb.input_text.trim().length >= MIN_UTTERANCE_LENGTH)
    .map((fb) => ({
      ...fb,
      text: fb.input_text.length > 512 ? fb.input_text.slice(0, 512) : fb.input_text,
    }));

  if (truncated.length === 0) return promotedUtterances;

  // Batch check for existing utterances to avoid N+1 queries
  const existingTexts = await findExistingUtterances(truncated.map((fb) => fb.text));

  const seen = new Set<string>();
  for (const fb of truncated) {
    if (existingTexts.has(fb.text) || seen.has(fb.text)) continue;
    seen.add(fb.text);

    const text = fb.text;

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

  // Acquire an advisory lock to prevent concurrent tuning runs. Runs older
  // than 1 hour with status='running' are treated as stale (crashed).
  if (!options.dryRun) {
    await acquireTunerLock(runId, options.hours);
  }

  try {
    // ----- Step 1: Aggregate outcome signals per agent+tier -----
    const agentTierOutcomes = await aggregateOutcomesByAgentTier(options.hours);
    const totalSignals = agentTierOutcomes.reduce((sum, o) => sum + o.total, 0);
    const tasksAnalyzed = await countTasksAnalyzed(options.hours);

    // ----- Step 2: Crystallize LLM escalation patterns into rules -----
    // Note: Steps 2-3 are not wrapped in a transaction. If step 3 fails
    // after step 2 writes rules, those rules persist (orphaned from the
    // tuning run record). This is an intentional trade-off — Dolt's
    // diff/revert capabilities make partial writes recoverable, and
    // wrapping the entire pipeline in a transaction would hold locks
    // across multiple slow queries.
    const escalations = await findSuccessfulEscalations(
      options.hours,
      options.crystallizeConfidenceThreshold,
    );
    const crystallizedRules = await crystallizeRules(escalations, options);

    // ----- Step 3: Promote successful fallback prompts to utterances -----
    const fallbacks = await findSuccessfulFallbacks(options.hours);
    const promotedUtterances = await promoteUtterances(fallbacks, options.dryRun);

    // ----- Step 4: Count actionable outcome scores -----
    const actionableScores = agentTierOutcomes.filter((o) => o.total >= options.minSampleSize);

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
      actionable_agent_tier_combos: actionableScores.length,
    };

    if (!options.dryRun) {
      await finalizeTuningRun(result);

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
      } catch (commitErr) {
        logger.error("doltCommit failed after tuning run", {
          component: "routing-tuner",
          error: (commitErr as Error).message,
        });
      }
    }

    return result;
  } catch (err) {
    if (!options.dryRun) {
      await recordTunerFailure(runId, err instanceof Error ? err.message : "unknown");
    }
    throw err;
  } finally {
    if (!options.dryRun) {
      await releaseTunerLock();
    }
  }
}
