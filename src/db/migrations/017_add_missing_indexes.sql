-- Add indexes for columns frequently used in WHERE, JOIN, and ORDER BY clauses

-- execution_log.task_id — queried by findByTaskId lookups
CREATE INDEX idx_execution_log_task_id ON execution_log (task_id);

-- task_log.selected_agent_id — joined in outcome aggregation / routing-tuner queries
CREATE INDEX idx_task_log_selected_agent_id ON task_log (selected_agent_id);

-- task_log.created_at — filtered by time-window in multiple queries
CREATE INDEX idx_task_log_created_at ON task_log (created_at);

-- routing_log.request_id — joined to task_log.task_id in tuner queries
CREATE INDEX idx_routing_log_request_id ON routing_log (request_id);

-- routing_utterances.embedding_model — filtered in reference store readiness checks
-- Note: low-cardinality column with != predicate; limited B-tree utility.
-- A future is_ready boolean column would be more selective.
CREATE INDEX idx_utterances_embedding_model ON routing_utterances (embedding_model);

-- execution_log.created_at — filtered by time-window in observability queries
CREATE INDEX idx_execution_log_created_at ON execution_log (created_at);
