import { describe, it, expect } from "vitest";
import {
  percentile,
  percentileBlock,
  shareByLayer,
  shareByTier,
  latencyByLayer,
} from "../../src/observability/cascade.js";

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the only value for a single-element array regardless of p", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("computes nearest-rank percentiles", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 99)).toBe(10);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    const snapshot = [...input];
    percentile(input, 50);
    expect(input).toEqual(snapshot);
  });
});

describe("percentileBlock", () => {
  it("returns zeroed block for empty input", () => {
    expect(percentileBlock([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it("computes p50/p95/p99/max with two-decimal rounding", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const block = percentileBlock(v);
    expect(block.p50).toBe(50);
    expect(block.p95).toBe(95);
    expect(block.p99).toBe(99);
    expect(block.max).toBe(100);
  });

  it("rounds float inputs to 2dp", () => {
    expect(percentileBlock([0.123456])).toEqual({
      p50: 0.12,
      p95: 0.12,
      p99: 0.12,
      max: 0.12,
    });
  });
});

describe("shareByLayer", () => {
  it("ensures all four known layers are present even when some have zero counts", () => {
    const { total, out } = shareByLayer([
      { layer: "deterministic", count: 80 },
      { layer: "semantic", count: 20 },
    ]);
    expect(total).toBe(100);
    expect(out.deterministic).toEqual({ count: 80, share: 0.8 });
    expect(out.semantic).toEqual({ count: 20, share: 0.2 });
    expect(out.escalation).toEqual({ count: 0, share: 0 });
    expect(out.fallback).toEqual({ count: 0, share: 0 });
  });

  it("rounds shares to 4dp and sums close to 1", () => {
    const { out } = shareByLayer([
      { layer: "deterministic", count: 1 },
      { layer: "semantic", count: 1 },
      { layer: "escalation", count: 1 },
    ]);
    // 1/3 = 0.3333 (4dp). Three of them sum to 0.9999 — accept rounding noise.
    const sum = out.deterministic.share + out.semantic.share + out.escalation.share;
    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThanOrEqual(1);
  });

  it("ignores unknown layer names without crashing", () => {
    // Forward compatibility: if a future migration adds a new layer name,
    // the snapshot endpoint shouldn't break — it just won't aggregate it.
    const { total, out } = shareByLayer([
      { layer: "deterministic", count: 5 },
      { layer: "unicorn", count: 3 },
    ]);
    expect(total).toBe(8); // total still includes the unknown bucket
    expect(out.deterministic.count).toBe(5);
    expect(Object.keys(out)).toEqual(["deterministic", "semantic", "escalation", "fallback"]);
  });

  it("returns zeroed block when no rows are supplied", () => {
    const { total, out } = shareByLayer([]);
    expect(total).toBe(0);
    for (const layer of ["deterministic", "semantic", "escalation", "fallback"] as const) {
      expect(out[layer]).toEqual({ count: 0, share: 0 });
    }
  });
});

describe("shareByTier", () => {
  it("computes share per tier and stringifies tier keys", () => {
    const out = shareByTier([
      { tier: 1, count: 25 },
      { tier: 2, count: 25 },
      { tier: 3, count: 50 },
    ]);
    expect(out["1"]).toEqual({ count: 25, share: 0.25 });
    expect(out["2"]).toEqual({ count: 25, share: 0.25 });
    expect(out["3"]).toEqual({ count: 50, share: 0.5 });
  });

  it("returns an empty object when no tiers are present", () => {
    expect(shareByTier([])).toEqual({});
  });
});

describe("latencyByLayer", () => {
  it("groups samples by layer and computes percentile blocks", () => {
    const samples = [
      { layer: "deterministic", latency_ms: 1, confidence: null, similarity_score: null },
      { layer: "deterministic", latency_ms: 2, confidence: null, similarity_score: null },
      { layer: "semantic", latency_ms: 100, confidence: 0.8, similarity_score: 0.7 },
      { layer: "semantic", latency_ms: 200, confidence: 0.85, similarity_score: 0.75 },
      { layer: "escalation", latency_ms: 500, confidence: 0.9, similarity_score: null },
    ];
    const out = latencyByLayer(samples);
    expect(out.deterministic).toBeDefined();
    expect(out.semantic).toBeDefined();
    expect(out.escalation).toBeDefined();
    expect(out.deterministic!.max).toBe(2);
    expect(out.semantic!.max).toBe(200);
    expect(out.escalation!.max).toBe(500);
  });

  it("omits layers that have no samples", () => {
    const out = latencyByLayer([
      { layer: "deterministic", latency_ms: 1, confidence: null, similarity_score: null },
    ]);
    expect(out.deterministic).toBeDefined();
    expect(out.semantic).toBeUndefined();
    expect(out.escalation).toBeUndefined();
    expect(out.fallback).toBeUndefined();
  });

  it("ignores unknown layer names", () => {
    const out = latencyByLayer([
      { layer: "future-layer", latency_ms: 999, confidence: null, similarity_score: null },
      { layer: "deterministic", latency_ms: 1, confidence: null, similarity_score: null },
    ]);
    expect(Object.keys(out)).toEqual(["deterministic"]);
  });
});
