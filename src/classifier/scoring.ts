import type { ComplexityTier } from "../types/task.js";

export function computeTier(
  prompt: string,
  tierBump: number,
  capabilityCount: number,
): ComplexityTier {
  let tier = 1;

  // Token estimate: prompt.length / 4
  const estimatedTokens = prompt.length / 4;
  if (estimatedTokens > 2000) {
    tier += 1;
  }

  // Add tierBump from matched rules
  tier += tierBump;

  // If many capabilities required
  if (capabilityCount >= 3) {
    tier += 1;
  }

  // Clamp to [1, 4]
  tier = Math.max(1, Math.min(4, tier));

  return tier as ComplexityTier;
}

const COST_CEILINGS: Record<number, number> = {
  1: 0.01,
  2: 0.05,
  3: 0.5,
  4: 5.0,
};

export function costCeilingForTier(tier: ComplexityTier): number {
  return COST_CEILINGS[tier];
}
