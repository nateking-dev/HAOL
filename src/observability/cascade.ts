import { createHash } from "node:crypto";
import {
  cascadeLayerCounts,
  cascadeTierCounts,
  cascadeDecisionSamples,
  cascadeNearMisses,
  cascadeTimeseries,
  type DecisionSampleRow,
} from "./cascade-queries.js";

const KNOWN_LAYERS = ["deterministic", "semantic", "escalation", "fallback"] as const;
type KnownLayer = (typeof KNOWN_LAYERS)[number];

const SAMPLE_LIMIT = 10_000;
const NEAR_MISS_LIMIT = 20;
const NEAR_MISS_TEXT_MAX = 200;

export interface CascadeSnapshot {
  window_hours: number;
  // ISO8601 timestamp captured at the start of the snapshot. The four
  // underlying queries fire concurrently on independent connections, so
  // counts and percentile distributions reflect slightly different points
  // in time under heavy concurrent writes — see `consistency` below.
  snapshot_at: string;
  // "best_effort" — counts and distributions are aggregated from
  // independent queries and may briefly disagree by a handful of rows
  // when new decisions are being inserted. Tolerable for monitoring;
  // not suitable for accounting.
  consistency: "best_effort";
  total_decisions: number;
  by_layer: Record<KnownLayer, { count: number; share: number }>;
  by_tier: Record<string, { count: number; share: number }>;
  latency_ms: PercentileBlock;
  latency_by_layer_ms: Partial<Record<KnownLayer, PercentileBlock>>;
  confidence: PercentileBlock | null;
  similarity_score: PercentileBlock | null;
  near_misses: NearMissEntry[];
  sample_size: number;
  sample_truncated: boolean;
}

export interface PercentileBlock {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface NearMissEntry {
  // SHA-256 of the original input_text. Always present so consumers can
  // dedupe identical near-misses across calls without ever seeing the
  // prompt content.
  input_text_sha256: string;
  // Raw input prompt (truncated). Only populated when the caller passes
  // includeText: true. Default omits it so that observability access
  // (already auth-gated) doesn't double as a PII firehose for whoever
  // holds the API key.
  input_text?: string;
  similarity_score: number;
  routed_tier: number;
  routing_layer: string;
  created_at: string;
}

export interface CascadeTimeseriesEntry {
  bucket_start: string;
  total: number;
  escalations: number;
  fallbacks: number;
  escalation_rate: number;
  fallback_rate: number;
  avg_latency_ms: number;
}

export interface CascadeTimeseriesResponse {
  window_hours: number;
  bucket_hours: number;
  buckets: CascadeTimeseriesEntry[];
}

// ── Pure helpers ────────────────────────────────────────────────

/** Nearest-rank percentile: same algorithm as load-test.ts so the two surfaces stay comparable. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function percentileBlock(values: number[]): PercentileBlock {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  // reduce instead of Math.max(...values): the spread form throws on arrays
  // larger than the engine's argument-count limit (~65k in V8). SAMPLE_LIMIT
  // is well under that today, but reduce has no such ceiling.
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return {
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(max),
  };
}

/**
 * Build the by-layer block, ensuring every known layer is present (with
 * zero counts if absent). Callers want a stable shape they can chart
 * without fear of missing keys.
 */
export function shareByLayer(rows: { layer: string; count: number }[]): {
  total: number;
  out: CascadeSnapshot["by_layer"];
} {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const out = Object.fromEntries(
    KNOWN_LAYERS.map((l) => [l, { count: 0, share: 0 }]),
  ) as CascadeSnapshot["by_layer"];
  for (const r of rows) {
    if (!isKnownLayer(r.layer)) continue;
    out[r.layer] = {
      count: r.count,
      share: total === 0 ? 0 : round4(r.count / total),
    };
  }
  return { total, out };
}

export function shareByTier(rows: { tier: number; count: number }[]): CascadeSnapshot["by_tier"] {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const out: CascadeSnapshot["by_tier"] = {};
  for (const r of rows) {
    out[String(r.tier)] = {
      count: r.count,
      share: total === 0 ? 0 : round4(r.count / total),
    };
  }
  return out;
}

export function latencyByLayer(
  samples: DecisionSampleRow[],
): CascadeSnapshot["latency_by_layer_ms"] {
  const groups: Partial<Record<KnownLayer, number[]>> = {};
  for (const s of samples) {
    if (!isKnownLayer(s.layer)) continue;
    (groups[s.layer] ??= []).push(s.latency_ms);
  }
  const out: CascadeSnapshot["latency_by_layer_ms"] = {};
  for (const [layer, vals] of Object.entries(groups) as [KnownLayer, number[]][]) {
    if (vals.length > 0) out[layer] = percentileBlock(vals);
  }
  return out;
}

function isKnownLayer(s: string): s is KnownLayer {
  return (KNOWN_LAYERS as readonly string[]).includes(s);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ── Composed service entry points ───────────────────────────────

export interface SnapshotOptions {
  /**
   * When true, near_misses includes the raw `input_text` (truncated to
   * NEAR_MISS_TEXT_MAX). Default false — the SHA-256 is always returned
   * so consumers can dedupe identical near-misses without seeing prompt
   * content. Only enable for ad-hoc debugging; do not surface to
   * dashboards or third-party integrations.
   */
  includeText?: boolean;
}

export async function getCascadeSnapshot(
  hours: number,
  opts: SnapshotOptions = {},
): Promise<CascadeSnapshot> {
  const snapshotAt = new Date().toISOString();
  const [layerRows, tierRows, samples, nearMisses] = await Promise.all([
    cascadeLayerCounts(hours),
    cascadeTierCounts(hours),
    cascadeDecisionSamples(hours, SAMPLE_LIMIT),
    cascadeNearMisses(hours, NEAR_MISS_LIMIT),
  ]);

  const { total, out: byLayer } = shareByLayer(layerRows);
  const byTier = shareByTier(tierRows);

  const latencies = samples.map((s) => s.latency_ms);
  const confidences = samples.map((s) => s.confidence).filter((v): v is number => v !== null);
  const similarities = samples
    .map((s) => s.similarity_score)
    .filter((v): v is number => v !== null);

  return {
    window_hours: hours,
    snapshot_at: snapshotAt,
    consistency: "best_effort",
    total_decisions: total,
    by_layer: byLayer,
    by_tier: byTier,
    latency_ms: percentileBlock(latencies),
    latency_by_layer_ms: latencyByLayer(samples),
    confidence: confidences.length === 0 ? null : percentileBlock(confidences),
    similarity_score: similarities.length === 0 ? null : percentileBlock(similarities),
    near_misses: nearMisses.map((n) => {
      const entry: NearMissEntry = {
        input_text_sha256: sha256(n.input_text),
        similarity_score: n.similarity_score,
        routed_tier: n.routed_tier,
        routing_layer: n.routing_layer,
        created_at: n.created_at,
      };
      if (opts.includeText) entry.input_text = truncate(n.input_text, NEAR_MISS_TEXT_MAX);
      return entry;
    }),
    sample_size: samples.length,
    sample_truncated: samples.length >= SAMPLE_LIMIT,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function getCascadeTimeseries(
  hours: number,
  bucketHours: number,
): Promise<CascadeTimeseriesResponse> {
  const rows = await cascadeTimeseries(hours, bucketHours);
  return {
    window_hours: hours,
    bucket_hours: bucketHours,
    buckets: rows.map((r) => ({
      bucket_start: r.bucket_start,
      total: r.total,
      escalations: r.escalations,
      fallbacks: r.fallbacks,
      escalation_rate: r.total === 0 ? 0 : round4(r.escalations / r.total),
      fallback_rate: r.total === 0 ? 0 : round4(r.fallbacks / r.total),
      avg_latency_ms: round(r.avg_latency_ms),
    })),
  };
}
