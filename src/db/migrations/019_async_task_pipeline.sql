-- Async task pipeline: POST /tasks now returns 202 immediately and a
-- background worker drives the classify/select/execute pipeline. To support
-- this, task_log needs to store the original input (so the reaper can
-- re-enqueue stranded QUEUED rows after a process crash) and worker
-- bookkeeping columns. A new QUEUED status sits before RECEIVED, and a
-- composite index makes the reaper/worker poll cheap.
--
-- QUEUED is appended (not prepended) to the ENUM to preserve the integer
-- ordinals of existing values. Order in the ENUM declaration is storage
-- order, not workflow order.

ALTER TABLE task_log
  MODIFY status ENUM('RECEIVED','CLASSIFIED','DISPATCHED','COMPLETED','FAILED','QUEUED') NOT NULL;

ALTER TABLE task_log ADD COLUMN prompt LONGTEXT DEFAULT NULL;

ALTER TABLE task_log ADD COLUMN input_metadata JSON DEFAULT NULL;

ALTER TABLE task_log ADD COLUMN input_constraints JSON DEFAULT NULL;

ALTER TABLE task_log ADD COLUMN worker_started_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE task_log ADD COLUMN worker_finished_at TIMESTAMP NULL DEFAULT NULL;

ALTER TABLE task_log ADD COLUMN worker_error TEXT DEFAULT NULL;

-- The winning agent's response. Today this lives only in the in-memory
-- return value of routeTask() — for the async pipeline, GET /tasks/:id
-- needs a persistent place to read it from.
ALTER TABLE task_log ADD COLUMN response_content LONGTEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_task_log_status_created ON task_log (status, created_at);
