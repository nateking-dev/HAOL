CREATE TABLE IF NOT EXISTS routing_policy (
  policy_id         VARCHAR(64)   PRIMARY KEY,
  weight_capability DECIMAL(3,2)  NOT NULL,
  weight_cost       DECIMAL(3,2)  NOT NULL,
  weight_latency    DECIMAL(3,2)  NOT NULL,
  fallback_strategy ENUM('NEXT_BEST','TIER_UP','ABORT') NOT NULL,
  max_retries       TINYINT       NOT NULL,
  active            BOOLEAN       NOT NULL DEFAULT FALSE
);
