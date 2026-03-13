import { query, execute } from "../db/connection.js";
import { uuidv7 } from "../types/task.js";
import type { RowDataPacket } from "mysql2/promise";
import type {
  RoutingRule,
  ReferenceUtterance,
  RouterConfig,
  RoutingLayer,
  TierId,
} from "./types.js";

interface RuleRow extends RowDataPacket {
  rule_id: string;
  tier_id: number;
  rule_type: string;
  pattern: string;
  capabilities: string | null;
  priority: number;
  enabled: number;
  description: string | null;
}

interface UtteranceRow extends RowDataPacket {
  utterance_id: string;
  tier_id: number;
  utterance_text: string;
  embedding: string;
}

interface ConfigRow extends RowDataPacket {
  config_key: string;
  config_value: string;
}

interface CountRow extends RowDataPacket {
  cnt: number;
}

export async function loadRules(): Promise<RoutingRule[]> {
  const rows = await query<RuleRow[]>(
    `SELECT rule_id, tier_id, rule_type, pattern, capabilities, priority, enabled, description
     FROM routing_rules
     WHERE enabled = TRUE
     ORDER BY priority ASC`,
  );
  return rows.map((r) => ({
    rule_id: r.rule_id,
    tier_id: r.tier_id as TierId,
    rule_type: r.rule_type as RoutingRule["rule_type"],
    pattern: r.pattern,
    capabilities: r.capabilities
      ? typeof r.capabilities === "string"
        ? JSON.parse(r.capabilities)
        : r.capabilities
      : null,
    priority: r.priority,
    enabled: Boolean(r.enabled),
    description: r.description,
  }));
}

export async function loadUtterances(): Promise<ReferenceUtterance[]> {
  const rows = await query<UtteranceRow[]>(
    `SELECT utterance_id, tier_id, utterance_text, embedding
     FROM routing_utterances
     WHERE embedding_model != 'pending'`,
  );
  return rows.map((r) => ({
    utterance_id: r.utterance_id,
    tier_id: r.tier_id as TierId,
    utterance_text: r.utterance_text,
    embedding:
      typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding,
  }));
}

const CONFIG_DEFAULTS: RouterConfig = {
  embedding_model: "text-embedding-3-small",
  embedding_dimensions: 512,
  similarity_threshold: 0.72,
  escalation_threshold: 0.55,
  escalation_model: "claude-haiku-4-5-20251001",
  default_tier: 3 as TierId,
  top_k: 5,
  enable_escalation: true,
};

export async function loadConfig(): Promise<RouterConfig> {
  const rows = await query<ConfigRow[]>(
    `SELECT config_key, config_value FROM router_config`,
  );
  const map = new Map(rows.map((r) => [r.config_key, r.config_value]));

  return {
    embedding_model:
      map.get("embedding_model") ?? CONFIG_DEFAULTS.embedding_model,
    embedding_dimensions: parseInt(
      map.get("embedding_dimensions") ??
        String(CONFIG_DEFAULTS.embedding_dimensions),
      10,
    ),
    similarity_threshold: parseFloat(
      map.get("similarity_threshold") ??
        String(CONFIG_DEFAULTS.similarity_threshold),
    ),
    escalation_threshold: parseFloat(
      map.get("escalation_threshold") ??
        String(CONFIG_DEFAULTS.escalation_threshold),
    ),
    escalation_model:
      map.get("escalation_model") ?? CONFIG_DEFAULTS.escalation_model,
    default_tier: parseInt(
      map.get("default_tier") ?? String(CONFIG_DEFAULTS.default_tier),
      10,
    ) as TierId,
    top_k: parseInt(map.get("top_k") ?? String(CONFIG_DEFAULTS.top_k), 10),
    enable_escalation: (map.get("enable_escalation") ?? "true") === "true",
  };
}

export async function logDecision(
  requestId: string,
  inputText: string,
  routedTier: TierId,
  routingLayer: RoutingLayer,
  similarityScore: number | null,
  confidence: number,
  latencyMs: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await execute(
    `INSERT INTO routing_log
       (log_id, request_id, input_text, routed_tier, routing_layer, similarity_score, confidence, latency_ms, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(),
      requestId,
      inputText,
      routedTier,
      routingLayer,
      similarityScore,
      confidence,
      latencyMs,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

export async function hasEmbeddings(): Promise<boolean> {
  const rows = await query<CountRow[]>(
    `SELECT COUNT(*) AS cnt FROM routing_utterances WHERE embedding_model != 'pending'`,
  );
  return rows[0].cnt > 0;
}
