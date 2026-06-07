-- PII retention (#79): raw user text in task_log.prompt and
-- routing_log.input_text was stored indefinitely with no purge job. The
-- retention reaper (PROMPT_RETENTION_DAYS) now nulls the raw text after a
-- configurable window, leaving the non-reversible SHA-256 fingerprint behind
-- so audit/observability still work.
--
-- task_log already has a separate prompt_hash column and prompt is nullable
-- LONGTEXT, so it needs no schema change — the reaper just nulls `prompt`.
--
-- routing_log.input_text is NOT NULL and has no companion hash column. The
-- /observability/cascade near-misses view derives input_text_sha256 from the
-- raw text at read time, so nulling input_text would break that fingerprint.
-- Persist the hash in a dedicated column (populated going forward by
-- logDecision and backfilled here) and relax input_text to NULL so the reaper
-- can purge it.

ALTER TABLE routing_log ADD COLUMN input_text_sha256 CHAR(64) NULL;

-- Backfill the fingerprint for existing rows before any purge can null the
-- source text. SHA2(..., 256) matches the hex digest produced by sha256() in
-- src/types/task.ts.
UPDATE routing_log
   SET input_text_sha256 = SHA2(input_text, 256)
 WHERE input_text_sha256 IS NULL
   AND input_text IS NOT NULL;

ALTER TABLE routing_log MODIFY input_text TEXT NULL;
