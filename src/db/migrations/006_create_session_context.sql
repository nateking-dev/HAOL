CREATE TABLE IF NOT EXISTS session_context (
  session_id VARCHAR(36)  NOT NULL,
  `key`      VARCHAR(128) NOT NULL,
  value      JSON,
  updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, `key`)
);
