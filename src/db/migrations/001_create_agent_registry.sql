CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id          VARCHAR(64)    PRIMARY KEY,
  provider          VARCHAR(32)    NOT NULL,
  model_id          VARCHAR(128)   NOT NULL,
  capabilities      JSON           NOT NULL,
  cost_per_1k_input  DECIMAL(10,6) NOT NULL,
  cost_per_1k_output DECIMAL(10,6) NOT NULL,
  max_context_tokens INT           NOT NULL,
  avg_latency_ms    INT            DEFAULT 0,
  status            ENUM('active','degraded','disabled') NOT NULL,
  tier_ceiling      TINYINT        NOT NULL
);
