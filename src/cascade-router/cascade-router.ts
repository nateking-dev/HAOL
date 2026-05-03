import type {
  RoutingRule,
  ReferenceUtterance,
  RouterConfig,
  TierDefinition,
  TierId,
  RoutingDecision,
  EmbeddingProvider,
  EscalationProvider,
  LayerAttempt,
  CascadeTrace,
} from "./types.js";
import { skippedAttempt } from "./types.js";
import { matchRules } from "../classifier/rules.js";
import { costCeilingForTier } from "../classifier/scoring.js";
import { uuidv7, sha256 } from "../types/task.js";
import type { TaskInput, TaskClassification } from "../types/task.js";
import * as store from "./reference-store.js";
import { rankBySimilarity, weightedTierVote } from "./similarity.js";
import safe from "safe-regex";

export interface CascadeRouterOpts {
  embeddingProvider?: EmbeddingProvider;
  escalationProvider?: EscalationProvider;
}

interface LoadedState {
  rules: RoutingRule[];
  utterances: ReferenceUtterance[];
  config: RouterConfig;
  tiers: TierDefinition[];
}

export class CascadeRouter {
  private state: LoadedState | null = null;
  private embeddingProvider: EmbeddingProvider | undefined;
  private escalationProvider: EscalationProvider | undefined;

  private constructor(opts: CascadeRouterOpts) {
    this.embeddingProvider = opts.embeddingProvider;
    this.escalationProvider = opts.escalationProvider;
  }

  static async create(opts: CascadeRouterOpts = {}): Promise<CascadeRouter> {
    const router = new CascadeRouter(opts);
    await router.load();
    return router;
  }

  private async load(): Promise<void> {
    const [rules, utterances, config] = await Promise.all([
      store.loadRules(),
      store.loadUtterances(),
      store.loadConfig(),
    ]);

    // Load tier definitions from DB
    const { query } = await import("../db/connection.js");
    const tierRows = await query<any[]>(
      `SELECT tier_id, tier_name, description, default_agent FROM routing_tiers ORDER BY tier_id`,
    );
    const tiers: TierDefinition[] = tierRows.map((r: any) => ({
      tier_id: r.tier_id as TierId,
      tier_name: r.tier_name,
      description: r.description,
      default_agent: r.default_agent,
    }));

    this.state = { rules, utterances, config, tiers };
  }

  async classify(input: TaskInput, preAllocatedTaskId?: string): Promise<TaskClassification> {
    if (!this.state) {
      await this.load();
    }
    const { rules, utterances, config, tiers } = this.state!;

    const start = performance.now();
    const prompt = input.prompt;
    const metadata = input.metadata;
    const trace: LayerAttempt[] = [];

    // Always run regex capability detection
    const { capabilities: regexCapabilities } = matchRules(prompt);
    const allCapabilities = new Set<string>(regexCapabilities);

    if (metadata?.capabilities) {
      for (const cap of metadata.capabilities) {
        allCapabilities.add(cap);
      }
    }

    let tier: TierId = config.default_tier;
    let layer: RoutingDecision["layer"] = "fallback";
    let confidence = 1.0;
    let similarityScore: number | null = null;
    let resolved = false;

    // Metadata tier override — skip all layers
    if (metadata?.tier !== undefined) {
      tier = metadata.tier;
      layer = "deterministic";
      confidence = 1.0;
      resolved = true;
      trace.push({
        layer: "deterministic",
        status: "matched",
        confidence: 1.0,
        similarity_score: null,
        latency_ms: performance.now() - start,
        tier: metadata.tier,
        reason: "metadata tier override",
      });
      trace.push(skippedAttempt("semantic", "metadata override — skipped"));
      trace.push(skippedAttempt("escalation", "metadata override — skipped"));
      trace.push(skippedAttempt("fallback", "metadata override — skipped"));
    } else {
      // Layer 0: Deterministic rules
      const l0Start = performance.now();
      const l0Result = this.runDeterministicRules(prompt, rules);
      const l0Latency = performance.now() - l0Start;

      if (l0Result) {
        tier = l0Result.tier;
        layer = "deterministic";
        confidence = 1.0;
        resolved = true;
        for (const cap of l0Result.capabilities) {
          allCapabilities.add(cap);
        }
        trace.push({
          layer: "deterministic",
          status: "matched",
          confidence: 1.0,
          similarity_score: null,
          latency_ms: l0Latency,
          tier: l0Result.tier,
          reason: "rule matched",
        });
        // Remaining layers skipped
        trace.push(skippedAttempt("semantic", "deterministic layer resolved"));
        trace.push(skippedAttempt("escalation", "deterministic layer resolved"));
        trace.push(skippedAttempt("fallback", "deterministic layer resolved"));
      } else {
        trace.push({
          layer: "deterministic",
          status: "missed",
          confidence: null,
          similarity_score: null,
          latency_ms: l0Latency,
          tier: null,
          reason: "no rules matched",
        });

        // Layer 1: Semantic similarity
        if (utterances.length > 0 && this.embeddingProvider) {
          const l1Start = performance.now();
          const queryEmbedding = await this.embeddingProvider.embed(prompt);
          const matches = rankBySimilarity(queryEmbedding, utterances, config.top_k);
          const vote = weightedTierVote(matches);
          const l1Latency = performance.now() - l1Start;
          similarityScore = matches.length > 0 ? matches[0].score : null;

          if (vote.confidence >= config.similarity_threshold) {
            tier = vote.tier;
            layer = "semantic";
            confidence = vote.confidence;
            resolved = true;
            trace.push({
              layer: "semantic",
              status: "matched",
              confidence: vote.confidence,
              similarity_score: similarityScore,
              latency_ms: l1Latency,
              tier: vote.tier,
              reason: `confidence ${vote.confidence.toFixed(2)} >= threshold ${config.similarity_threshold}`,
            });
            trace.push(skippedAttempt("escalation", "semantic layer resolved"));
            trace.push(skippedAttempt("fallback", "semantic layer resolved"));
          } else {
            trace.push({
              layer: "semantic",
              status: "missed",
              confidence: vote.confidence,
              similarity_score: similarityScore,
              latency_ms: l1Latency,
              tier: vote.tier,
              reason: `confidence ${vote.confidence.toFixed(2)} < threshold ${config.similarity_threshold}`,
            });

            // Layer 2: LLM escalation
            const esc = await this.tryEscalation(prompt, config, tiers, allCapabilities);
            trace.push(esc.attempt);
            if (esc.resolved) {
              tier = esc.tier!;
              layer = "escalation";
              confidence = esc.confidence!;
              resolved = true;
              if (esc.fallbackAttempt) trace.push(esc.fallbackAttempt);
            }
          }
        } else {
          // No utterances/embeddings — skip semantic
          const skipReason =
            utterances.length === 0 ? "no reference utterances" : "no embedding provider";
          trace.push(skippedAttempt("semantic", skipReason));

          // Layer 2: LLM escalation (no semantic available)
          const esc = await this.tryEscalation(prompt, config, tiers, allCapabilities);
          trace.push(esc.attempt);
          if (esc.resolved) {
            tier = esc.tier!;
            layer = "escalation";
            confidence = esc.confidence!;
            resolved = true;
            if (esc.fallbackAttempt) trace.push(esc.fallbackAttempt);
          }
        }

        // Fallback — if nothing resolved yet
        if (!resolved) {
          tier = config.default_tier;
          layer = "fallback";
          confidence = 0;
          trace.push({
            layer: "fallback",
            status: "matched",
            confidence: 0,
            similarity_score: null,
            latency_ms: 0,
            tier: config.default_tier,
            reason: `defaulting to T${config.default_tier}`,
          });
        }
      }
    }

    const latencyMs = performance.now() - start;
    const taskId = preAllocatedTaskId ?? uuidv7();

    const cascadeTrace: CascadeTrace = {
      layers: trace,
      resolved_layer: layer,
      total_latency_ms: latencyMs,
    };

    // Best-effort log
    try {
      await store.logDecision(taskId, prompt, tier, layer, similarityScore, confidence, latencyMs, {
        cascade_trace: cascadeTrace,
      });
    } catch {
      // Don't fail classification if logging fails
    }

    return {
      task_id: taskId,
      complexity_tier: tier,
      required_capabilities: [...allCapabilities],
      cost_ceiling_usd: costCeilingForTier(tier),
      prompt_hash: sha256(prompt),
      routing_confidence: confidence,
      routing_layer: layer,
      cascade_trace: cascadeTrace,
    };
  }

  private async tryEscalation(
    prompt: string,
    config: RouterConfig,
    tiers: TierDefinition[],
    allCapabilities: Set<string>,
  ): Promise<{
    resolved: boolean;
    tier?: TierId;
    confidence?: number;
    attempt: LayerAttempt;
    fallbackAttempt?: LayerAttempt;
  }> {
    if (!config.enable_escalation || !this.escalationProvider || tiers.length === 0) {
      const reason = !config.enable_escalation
        ? "escalation disabled"
        : !this.escalationProvider
          ? "no escalation provider"
          : "no tier definitions";
      return {
        resolved: false,
        attempt: skippedAttempt("escalation", reason),
      };
    }

    const l2Start = performance.now();
    try {
      const escalation = await this.escalationProvider.classify(prompt, tiers);
      const l2Latency = performance.now() - l2Start;
      for (const cap of escalation.capabilities) {
        allCapabilities.add(cap);
      }
      return {
        resolved: true,
        tier: escalation.tier,
        confidence: escalation.confidence,
        attempt: {
          layer: "escalation",
          status: "matched",
          confidence: escalation.confidence,
          similarity_score: null,
          latency_ms: l2Latency,
          tier: escalation.tier,
          reason: "LLM classification resolved",
        },
        fallbackAttempt: skippedAttempt("fallback", "escalation layer resolved"),
      };
    } catch (err) {
      const l2Latency = performance.now() - l2Start;
      const message = (err as Error).message ?? String(err);
      return {
        resolved: false,
        attempt: {
          layer: "escalation",
          status: "error",
          confidence: null,
          similarity_score: null,
          latency_ms: l2Latency,
          tier: null,
          reason: `escalation failed: ${message.slice(0, 200)}`,
        },
      };
    }
  }

  private runDeterministicRules(
    prompt: string,
    rules: RoutingRule[],
  ): { tier: TierId; capabilities: string[] } | null {
    // The FIRST matched rule wins for tier — so a T1 rule at priority 10
    // short-circuits a T3 rule at priority 20 even if both match.
    // Capabilities still aggregate across all matched rules since they're
    // additive properties of the request, not ranked.
    //
    // Previously this picked max(tier) across all matches, which silently
    // ignored the priority column and meant any incidental T3 keyword
    // ("the analysis showed...", "the function returned...") would clobber
    // a clear T1/T2 instruction.
    //
    // loadRules() returns rules ORDER BY priority ASC, but we sort
    // defensively here so any alternate call path (tests, future
    // refactors) can't silently break the priority logic by passing
    // rules in a different order.
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);

    let winningTier: TierId | null = null;
    const capabilities: string[] = [];

    for (const rule of sorted) {
      let matched = false;

      switch (rule.rule_type) {
        case "regex":
          try {
            if (!safe(rule.pattern)) {
              console.warn(`Unsafe regex pattern rejected (ReDoS risk): rule=${rule.rule_id}`);
              // Log rejection so it surfaces in observability
              store
                .logDecision(uuidv7(), prompt, rule.tier_id, "deterministic", null, 0, 0, {
                  rejected_rule: rule.rule_id,
                  reason: "unsafe_regex",
                })
                .catch(() => {});
              break;
            }
            matched = new RegExp(rule.pattern, "i").test(prompt);
          } catch {
            // Invalid regex — skip
          }
          break;
        case "prefix":
          matched = prompt.toLowerCase().startsWith(rule.pattern.toLowerCase());
          break;
        case "contains":
          matched = prompt.toLowerCase().includes(rule.pattern.toLowerCase());
          break;
        case "metadata":
          // Metadata rules handled separately via tier override
          break;
      }

      if (matched) {
        if (winningTier === null) {
          winningTier = rule.tier_id;
        }
        if (rule.capabilities) {
          for (const cap of rule.capabilities) {
            if (!capabilities.includes(cap)) {
              capabilities.push(cap);
            }
          }
        }
      }
    }

    if (winningTier === null) return null;
    return { tier: winningTier, capabilities };
  }
}
