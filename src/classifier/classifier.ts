import { TaskInput, type TaskClassification, uuidv7, sha256 } from "../types/task.js";
import { matchRules } from "./rules.js";
import { computeTier, costCeilingForTier } from "./scoring.js";

export function classify(input: TaskInput): TaskClassification {
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

  return {
    task_id,
    complexity_tier: tier,
    required_capabilities: allCapabilities,
    cost_ceiling_usd,
    prompt_hash,
  };
}
