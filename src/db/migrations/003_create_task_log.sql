CREATE TABLE IF NOT EXISTS task_log (
  task_id               VARCHAR(36)   PRIMARY KEY,
  created_at            TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  status                ENUM('RECEIVED','CLASSIFIED','DISPATCHED','COMPLETED','FAILED') NOT NULL,
  prompt_hash           VARCHAR(64),
  complexity_tier       TINYINT,
  required_capabilities JSON,
  cost_ceiling_usd      DECIMAL(10,6),
  selected_agent_id     VARCHAR(64),
  selection_rationale   JSON
);
