import type {
  RoutingRule,
  ReferenceUtterance,
  RouterConfig,
  TierDefinition,
  TierId,
  RoutingDecision,
  EmbeddingProvider,
  EscalationProvider,
} from "./types.js";
import { matchRules } from "../classifier/rules.js";
import { costCeilingForTier } from "../classifier/scoring.js";
import { uuidv7, sha256 } from "../types/task.js";
import type { TaskInput, TaskClassification } from "../types/task.js";
import * as store from "./reference-store.js";
import { rankBySimilarity, weightedTierVote } from "./similarity.js";

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

  async classify(input: TaskInput): Promise<TaskClassification> {
    if (!this.state) {
      await this.load();
    }
    const { rules, utterances, config, tiers } = this.state!;

    const start = performance.now();
    const prompt = input.prompt;
    const metadata = input.metadata;

    // Always run regex capability detection
    const { capabilities: regexCapabilities } = matchRules(prompt);
    const allCapabilities = new Set<string>(regexCapabilities);

    if (metadata?.capabilities) {
      for (const cap of metadata.capabilities) {
        allCapabilities.add(cap);
      }
    }

    let tier: TierId;
    let layer: RoutingDecision["layer"];
    let confidence = 1.0;
    let similarityScore: number | null = null;

    // Metadata tier override — skip all layers
    if (metadata?.tier !== undefined) {
      tier = metadata.tier;
      layer = "deterministic";
      confidence = 1.0;
    } else {
      // Layer 0: Deterministic rules
      const l0Result = this.runDeterministicRules(prompt, rules);

      if (l0Result) {
        tier = l0Result.tier;
        layer = "deterministic";
        confidence = 1.0;
        // Merge capabilities from matched rules
        for (const cap of l0Result.capabilities) {
          allCapabilities.add(cap);
        }
      } else if (utterances.length > 0 && this.embeddingProvider) {
        // Layer 1: Semantic similarity
        const queryEmbedding = await this.embeddingProvider.embed(prompt);
        const matches = rankBySimilarity(queryEmbedding, utterances, config.top_k);
        const vote = weightedTierVote(matches);
        similarityScore = matches.length > 0 ? matches[0].score : null;

        if (vote.confidence >= config.similarity_threshold) {
          tier = vote.tier;
          layer = "semantic";
          confidence = vote.confidence;
        } else if (
          vote.confidence >= config.escalation_threshold &&
          config.enable_escalation &&
          this.escalationProvider &&
          tiers.length > 0
        ) {
          // Layer 2: LLM escalation
          const escalation = await this.escalationProvider.classify(prompt, tiers);
          tier = escalation.tier;
          layer = "escalation";
          confidence = escalation.confidence;
          for (const cap of escalation.capabilities) {
            allCapabilities.add(cap);
          }
        } else if (config.enable_escalation && this.escalationProvider && tiers.length > 0) {
          // Low confidence — also escalate
          const escalation = await this.escalationProvider.classify(prompt, tiers);
          tier = escalation.tier;
          layer = "escalation";
          confidence = escalation.confidence;
          for (const cap of escalation.capabilities) {
            allCapabilities.add(cap);
          }
        } else {
          // Fallback
          tier = config.default_tier;
          layer = "fallback";
          confidence = 0;
        }
      } else if (config.enable_escalation && this.escalationProvider && tiers.length > 0) {
        // No utterances but escalation available
        const escalation = await this.escalationProvider.classify(prompt, tiers);
        tier = escalation.tier;
        layer = "escalation";
        confidence = escalation.confidence;
        for (const cap of escalation.capabilities) {
          allCapabilities.add(cap);
        }
      } else {
        // Fallback
        tier = config.default_tier;
        layer = "fallback";
        confidence = 0;
      }
    }

    const latencyMs = performance.now() - start;
    const taskId = uuidv7();

    // Best-effort log
    try {
      await store.logDecision(taskId, prompt, tier, layer, similarityScore, confidence, latencyMs);
    } catch {
      // Don't fail classification if logging fails
    }

    return {
      task_id: taskId,
      complexity_tier: tier,
      required_capabilities: [...allCapabilities],
      cost_ceiling_usd: costCeilingForTier(tier),
      prompt_hash: sha256(prompt),
    };
  }

  private runDeterministicRules(
    prompt: string,
    rules: RoutingRule[],
  ): { tier: TierId; capabilities: string[] } | null {
    let highestTier: TierId | null = null;
    const capabilities: string[] = [];

    for (const rule of rules) {
      let matched = false;

      switch (rule.rule_type) {
        case "regex":
          try {
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
        if (highestTier === null || rule.tier_id > highestTier) {
          highestTier = rule.tier_id;
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

    if (highestTier === null) return null;
    return { tier: highestTier, capabilities };
  }
}
