CREATE TABLE IF NOT EXISTS task_outcome (
  outcome_id    VARCHAR(36)   PRIMARY KEY,
  task_id       VARCHAR(36)   NOT NULL,
  tier          TINYINT       NOT NULL,
  source        VARCHAR(64)   NOT NULL,
  signal_type   VARCHAR(64)   NOT NULL,
  signal_value  TINYINT       NOT NULL,
  confidence    FLOAT         DEFAULT NULL,
  detail        JSON          DEFAULT NULL,
  reported_by   VARCHAR(128)  DEFAULT NULL,
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_outcome_task (task_id),
  KEY idx_outcome_tier (tier),
  KEY idx_outcome_signal (signal_type),
  KEY idx_outcome_created (created_at)
);
