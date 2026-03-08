-- HAOL Cascade Router — Schema
-- 3-layer cascade: deterministic rules → semantic similarity → LLM escalation

-- ============================================================
-- Tier definitions
-- ============================================================
CREATE TABLE IF NOT EXISTS routing_tiers (
    tier_id         TINYINT      PRIMARY KEY,
    tier_name       VARCHAR(64)  NOT NULL,
    description     TEXT,
    default_agent   VARCHAR(128) NOT NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- Deterministic rules (Layer 0)
-- ============================================================
CREATE TABLE IF NOT EXISTS routing_rules (
    rule_id         VARCHAR(36)  PRIMARY KEY,
    tier_id         TINYINT      NOT NULL,
    rule_type       ENUM('regex', 'prefix', 'contains', 'metadata') NOT NULL,
    pattern         TEXT         NOT NULL,
    capabilities    JSON         DEFAULT NULL,
    priority        INT          NOT NULL DEFAULT 100,
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    description     TEXT,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_rules_priority (priority, enabled),
    FOREIGN KEY (tier_id) REFERENCES routing_tiers(tier_id)
);

-- ============================================================
-- Reference utterances (Layer 1 — semantic similarity)
-- ============================================================
CREATE TABLE IF NOT EXISTS routing_utterances (
    utterance_id    VARCHAR(36)  PRIMARY KEY,
    tier_id         TINYINT      NOT NULL,
    utterance_text  TEXT         NOT NULL,
    embedding       JSON         NOT NULL,
    embedding_model VARCHAR(128) NOT NULL,
    embedding_dim   INT          NOT NULL,
    source          VARCHAR(64)  DEFAULT 'manual',
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_utterances_tier (tier_id),
    FOREIGN KEY (tier_id) REFERENCES routing_tiers(tier_id)
);

-- ============================================================
-- Router configuration (key-value)
-- ============================================================
CREATE TABLE IF NOT EXISTS router_config (
    config_key      VARCHAR(64)  PRIMARY KEY,
    config_value    TEXT         NOT NULL,
    description     TEXT
);

-- ============================================================
-- Routing audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS routing_log (
    log_id          VARCHAR(36)  PRIMARY KEY,
    request_id      VARCHAR(36)  NOT NULL,
    input_text      TEXT         NOT NULL,
    routed_tier     TINYINT      NOT NULL,
    routing_layer   ENUM('deterministic', 'semantic', 'escalation', 'fallback') NOT NULL,
    similarity_score FLOAT,
    confidence      FLOAT,
    latency_ms      FLOAT        NOT NULL,
    metadata        JSON,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_log_created (created_at),
    KEY idx_log_tier (routed_tier),
    KEY idx_log_layer (routing_layer)
)
