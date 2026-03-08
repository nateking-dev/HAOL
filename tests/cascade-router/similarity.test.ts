import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  rankBySimilarity,
  weightedTierVote,
} from "../../src/cascade-router/similarity.js";
import type { TierId } from "../../src/cascade-router/types.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      "Dimension mismatch",
    );
  });

  it("handles normalized vectors correctly", () => {
    const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];
    const b = [1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2));
  });
});

describe("rankBySimilarity", () => {
  const utterances = [
    { utterance_id: "u1", tier_id: 1 as TierId, embedding: [1, 0, 0] },
    { utterance_id: "u2", tier_id: 2 as TierId, embedding: [0, 1, 0] },
    { utterance_id: "u3", tier_id: 3 as TierId, embedding: [0.9, 0.1, 0] },
  ];

  it("returns matches sorted by score descending", () => {
    const result = rankBySimilarity([1, 0, 0], utterances, 3);
    expect(result[0].utterance_id).toBe("u1");
    expect(result[0].score).toBeCloseTo(1.0);
    expect(result[1].utterance_id).toBe("u3");
  });

  it("respects topK limit", () => {
    const result = rankBySimilarity([1, 0, 0], utterances, 2);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty utterances", () => {
    const result = rankBySimilarity([1, 0], [], 5);
    expect(result).toHaveLength(0);
  });
});

describe("weightedTierVote", () => {
  it("returns the tier with highest weighted score", () => {
    const matches = [
      { utterance_id: "u1", tier_id: 2 as TierId, score: 0.9 },
      { utterance_id: "u2", tier_id: 2 as TierId, score: 0.8 },
      { utterance_id: "u3", tier_id: 1 as TierId, score: 0.7 },
    ];
    const result = weightedTierVote(matches);
    expect(result.tier).toBe(2);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("returns default tier 3 for empty matches", () => {
    const result = weightedTierVote([]);
    expect(result.tier).toBe(3);
    expect(result.confidence).toBe(0);
  });

  it("returns high confidence for unanimous votes", () => {
    const matches = [
      { utterance_id: "u1", tier_id: 1 as TierId, score: 0.9 },
      { utterance_id: "u2", tier_id: 1 as TierId, score: 0.8 },
    ];
    const result = weightedTierVote(matches);
    expect(result.tier).toBe(1);
    expect(result.confidence).toBeCloseTo(1.0);
  });

  it("returns lower confidence for split votes", () => {
    const matches = [
      { utterance_id: "u1", tier_id: 1 as TierId, score: 0.5 },
      { utterance_id: "u2", tier_id: 2 as TierId, score: 0.5 },
    ];
    const result = weightedTierVote(matches);
    expect(result.confidence).toBeCloseTo(0.5);
  });
});
