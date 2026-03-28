import { TaskInput, type TaskClassification, uuidv7, sha256 } from "../types/task.js";
import type { CascadeTrace, LayerAttempt } from "../cascade-router/types.js";
import { matchRules } from "./rules.js";
import { computeTier, costCeilingForTier } from "./scoring.js";

export function classify(input: TaskInput): TaskClassification {
  const start = performance.now();

  // 1. Validate input with Zod
  const parsed = TaskInput.parse(input);

  // 2. Run rule matching on the prompt
  const { capabilities: detectedCapabilities, tierBump } = matchRules(parsed.prompt);

  // 3. Merge metadata capabilities with detected ones
  const allCapabilities = [...detectedCapabilities];
  if (parsed.metadata?.capabilities) {
    for (const cap of parsed.metadata.capabilities) {
      if (!allCapabilities.includes(cap)) {
        allCapabilities.push(cap);
      }
    }
  }

  // 4. Determine tier: metadata override or computed
  let tier: 1 | 2 | 3 | 4;
  if (parsed.metadata?.tier !== undefined) {
    tier = parsed.metadata.tier;
  } else {
    tier = computeTier(parsed.prompt, tierBump, allCapabilities.length);
  }

  // 5. Compute cost ceiling
  const cost_ceiling_usd = costCeilingForTier(tier);

  // 6. Generate task ID and prompt hash
  const task_id = uuidv7();
  const prompt_hash = sha256(parsed.prompt);

  const elapsed = performance.now() - start;

  // 7. Build cascade trace for legacy classifier
  const deterministicAttempt: LayerAttempt = {
    layer: "deterministic",
    status: "matched",
    confidence: 1.0,
    similarity_score: null,
    latency_ms: elapsed,
    tier,
    reason: "legacy rule-based classifier — deterministic match",
  };

  const skippedLayers: LayerAttempt[] = (["semantic", "escalation", "fallback"] as const).map(
    (layer) => ({
      layer,
      status: "skipped" as const,
      confidence: null,
      similarity_score: null,
      latency_ms: 0,
      tier: null,
      reason: "legacy classifier — skipped",
    }),
  );

  const cascade_trace: CascadeTrace = {
    layers: [deterministicAttempt, ...skippedLayers],
    resolved_layer: "deterministic",
    total_latency_ms: elapsed,
  };

  return {
    task_id,
    complexity_tier: tier,
    required_capabilities: allCapabilities,
    cost_ceiling_usd,
    prompt_hash,
    routing_confidence: 1.0,
    routing_layer: "deterministic",
    cascade_trace,
  };
}
