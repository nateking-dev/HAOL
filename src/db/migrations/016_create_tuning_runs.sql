-- Routing tuner — tracks tuning cycles and their adjustments

CREATE TABLE IF NOT EXISTS tuning_run (
    run_id          VARCHAR(36)   PRIMARY KEY,
    started_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP     NULL,
    status          ENUM('running', 'completed', 'failed', 'dry_run') NOT NULL DEFAULT 'running',
    hours_window    INT           NOT NULL,
    tasks_analyzed  INT           NOT NULL DEFAULT 0,
    signals_used    INT           NOT NULL DEFAULT 0,
    rules_created   INT           NOT NULL DEFAULT 0,
    utterances_added INT          NOT NULL DEFAULT 0,
    outcome_scores_updated INT    NOT NULL DEFAULT 0,
    summary         JSON          DEFAULT NULL,
    error_message   TEXT          DEFAULT NULL,
    KEY idx_tuning_status (status),
    KEY idx_tuning_started (started_at)
);
