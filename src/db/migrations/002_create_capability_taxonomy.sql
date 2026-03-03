CREATE TABLE IF NOT EXISTS capability_taxonomy (
  capability_key VARCHAR(64)  PRIMARY KEY,
  display_name   VARCHAR(128) NOT NULL,
  description    TEXT,
  tier_minimum   TINYINT      DEFAULT 1
);
