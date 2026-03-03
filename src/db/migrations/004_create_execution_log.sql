CREATE TABLE IF NOT EXISTS execution_log (
  execution_id   VARCHAR(36)   PRIMARY KEY,
  task_id        VARCHAR(36)   NOT NULL,
  agent_id       VARCHAR(64)   NOT NULL,
  attempt_number TINYINT       NOT NULL,
  input_tokens   INT,
  output_tokens  INT,
  cost_usd       DECIMAL(10,6),
  latency_ms     INT,
  ttft_ms        INT,
  outcome        ENUM('SUCCESS','TIMEOUT','ERROR','FALLBACK') NOT NULL,
  error_detail   TEXT,
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);
