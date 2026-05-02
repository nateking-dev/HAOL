import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";

// Thin SQL layer for cascade-router observability. All aggregation that
// requires percentiles is done in the service layer (see ./cascade.ts) so
// the queries stay portable across MySQL/Dolt versions and easy to test.

export interface LayerCountRow {
  layer: string;
  count: number;
}
interface LayerCountRaw extends RowDataPacket {
  routing_layer: string;
  cnt: string | number;
}

export async function cascadeLayerCounts(hours: number): Promise<LayerCountRow[]> {
  const rows = await query<LayerCountRaw[]>(
    `SELECT routing_layer, COUNT(*) AS cnt
     FROM routing_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY routing_layer`,
    [hours],
  );
  return rows.map((r) => ({
    layer: r.routing_layer,
    count: typeof r.cnt === "string" ? parseInt(r.cnt, 10) : Number(r.cnt),
  }));
}

export interface TierCountRow {
  tier: number;
  count: number;
}
interface TierCountRaw extends RowDataPacket {
  routed_tier: number;
  cnt: string | number;
}

export async function cascadeTierCounts(hours: number): Promise<TierCountRow[]> {
  const rows = await query<TierCountRaw[]>(
    `SELECT routed_tier, COUNT(*) AS cnt
     FROM routing_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY routed_tier
     ORDER BY routed_tier`,
    [hours],
  );
  return rows.map((r) => ({
    tier: Number(r.routed_tier),
    count: typeof r.cnt === "string" ? parseInt(r.cnt, 10) : Number(r.cnt),
  }));
}

export interface DecisionSampleRow {
  layer: string;
  latency_ms: number;
  confidence: number | null;
  similarity_score: number | null;
}
interface DecisionSampleRaw extends RowDataPacket {
  routing_layer: string;
  latency_ms: string | number;
  confidence: string | number | null;
  similarity_score: string | number | null;
}

/**
 * Pull the raw decision samples needed to compute percentiles and
 * distributions in the service layer. Bounded by `limit` so a wide window
 * doesn't pull millions of rows.
 */
export async function cascadeDecisionSamples(
  hours: number,
  limit: number,
): Promise<DecisionSampleRow[]> {
  const rows = await query<DecisionSampleRaw[]>(
    `SELECT routing_layer, latency_ms, confidence, similarity_score
     FROM routing_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY created_at DESC
     LIMIT ?`,
    [hours, limit],
  );
  return rows.map((r) => ({
    layer: r.routing_layer,
    latency_ms: typeof r.latency_ms === "string" ? parseFloat(r.latency_ms) : Number(r.latency_ms),
    confidence:
      r.confidence === null
        ? null
        : typeof r.confidence === "string"
          ? parseFloat(r.confidence)
          : Number(r.confidence),
    similarity_score:
      r.similarity_score === null
        ? null
        : typeof r.similarity_score === "string"
          ? parseFloat(r.similarity_score)
          : Number(r.similarity_score),
  }));
}

export interface NearMissRow {
  input_text: string;
  similarity_score: number;
  routed_tier: number;
  routing_layer: string;
  created_at: string;
}
interface NearMissRaw extends RowDataPacket {
  input_text: string;
  similarity_score: string | number;
  routed_tier: number;
  routing_layer: string;
  created_at: Date | string;
}

/**
 * Decisions where the semantic layer was consulted but did not resolve —
 * i.e., the cascade fell through to escalation or fallback. Sorted by
 * similarity_score DESC because the highest-scoring near-misses are the
 * most informative for tuning `similarity_threshold`.
 */
export async function cascadeNearMisses(hours: number, limit: number): Promise<NearMissRow[]> {
  const rows = await query<NearMissRaw[]>(
    `SELECT input_text, similarity_score, routed_tier, routing_layer, created_at
     FROM routing_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND routing_layer IN ('escalation', 'fallback')
       AND similarity_score IS NOT NULL
     ORDER BY similarity_score DESC
     LIMIT ?`,
    [hours, limit],
  );
  return rows.map((r) => ({
    input_text: r.input_text,
    similarity_score:
      typeof r.similarity_score === "string"
        ? parseFloat(r.similarity_score)
        : Number(r.similarity_score),
    routed_tier: Number(r.routed_tier),
    routing_layer: r.routing_layer,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export interface TimeseriesRow {
  bucket_start: string;
  total: number;
  escalations: number;
  fallbacks: number;
  avg_latency_ms: number;
}
interface TimeseriesRaw extends RowDataPacket {
  bucket_start: Date | string;
  total: string | number;
  escalations: string | number;
  fallbacks: string | number;
  avg_latency_ms: string | number | null;
}

/**
 * Bucketed counts for trending escalation rate and volume. `bucketHours`
 * is the bucket width in hours (1 = hourly, 24 = daily).
 */
export async function cascadeTimeseries(
  hours: number,
  bucketHours: number,
): Promise<TimeseriesRow[]> {
  // Floor each row's created_at to the bucket boundary by computing
  // FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / bucket_seconds) * bucket_seconds).
  // Done in SQL so the bucket key is stable regardless of how many rows fall in.
  const bucketSeconds = bucketHours * 3600;
  const rows = await query<TimeseriesRaw[]>(
    `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / ?) * ?) AS bucket_start,
            COUNT(*) AS total,
            SUM(CASE WHEN routing_layer = 'escalation' THEN 1 ELSE 0 END) AS escalations,
            SUM(CASE WHEN routing_layer = 'fallback' THEN 1 ELSE 0 END) AS fallbacks,
            AVG(latency_ms) AS avg_latency_ms
     FROM routing_log
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY bucket_start
     ORDER BY bucket_start ASC`,
    [bucketSeconds, bucketSeconds, hours],
  );
  return rows.map((r) => ({
    bucket_start:
      r.bucket_start instanceof Date ? r.bucket_start.toISOString() : String(r.bucket_start),
    total: typeof r.total === "string" ? parseInt(r.total, 10) : Number(r.total),
    escalations:
      typeof r.escalations === "string" ? parseInt(r.escalations, 10) : Number(r.escalations),
    fallbacks: typeof r.fallbacks === "string" ? parseInt(r.fallbacks, 10) : Number(r.fallbacks),
    avg_latency_ms:
      r.avg_latency_ms === null
        ? 0
        : typeof r.avg_latency_ms === "string"
          ? parseFloat(r.avg_latency_ms)
          : Number(r.avg_latency_ms),
  }));
}
