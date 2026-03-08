import type { SimilarityMatch, TierId } from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function rankBySimilarity(
  queryEmbedding: number[],
  utterances: { utterance_id: string; tier_id: TierId; embedding: number[] }[],
  topK: number,
): SimilarityMatch[] {
  const scored = utterances.map((u) => ({
    utterance_id: u.utterance_id,
    tier_id: u.tier_id,
    score: cosineSimilarity(queryEmbedding, u.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function weightedTierVote(
  matches: SimilarityMatch[],
): { tier: TierId; confidence: number } {
  if (matches.length === 0) {
    return { tier: 3 as TierId, confidence: 0 };
  }

  const tierWeights = new Map<number, number>();
  let totalWeight = 0;

  for (const match of matches) {
    const weight = match.score;
    tierWeights.set(match.tier_id, (tierWeights.get(match.tier_id) ?? 0) + weight);
    totalWeight += weight;
  }

  let bestTier = 3 as TierId;
  let bestWeight = 0;
  for (const [tier, weight] of tierWeights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestTier = tier as TierId;
    }
  }

  const confidence = totalWeight > 0 ? bestWeight / totalWeight : 0;
  return { tier: bestTier, confidence };
}
