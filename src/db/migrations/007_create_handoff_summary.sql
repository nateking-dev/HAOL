CREATE TABLE IF NOT EXISTS handoff_summary (
  task_id       VARCHAR(36) NOT NULL,
  from_agent_id VARCHAR(64) NOT NULL,
  summary       TEXT        NOT NULL,
  created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, from_agent_id)
);
