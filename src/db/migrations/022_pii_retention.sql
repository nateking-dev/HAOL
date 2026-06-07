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
--
-- KNOWN LIMITATION — Dolt commit history is NOT purged. Nulling a live row
-- removes the raw text from the working set and HEAD, but every prior Dolt
-- commit that captured the row still contains it. It remains readable via
-- Dolt's version history (`dolt log`, `dolt diff`, `... AS OF <commit>`).
-- This feature bounds disclosure through the SQL/API surface and the
-- observability endpoint; it does NOT provide cryptographic erasure or
-- right-to-be-forgotten guarantees against an operator with direct Dolt
-- history access. Compliance regimes that require true deletion need a
-- separate history-rewrite/retention strategy at the Dolt layer.
--
-- RETRY SAFETY — the three statements below are applied individually by the
-- migration runner (src/db/migrate.ts: splitStatements + execStatementsIdempotent).
-- If a crash/lock-timeout interrupts the UPDATE or final MODIFY, the next run
-- re-runs the file: the duplicate ADD COLUMN is caught and skipped (errno 1060
-- / "duplicate column name"), the UPDATE is idempotent (WHERE ... IS NULL), and
-- re-applying the MODIFY is a no-op. (Dolt does not accept ADD COLUMN IF NOT
-- EXISTS, so the runner's duplicate-DDL recovery is what provides idempotency.)

ALTER TABLE routing_log ADD COLUMN input_text_sha256 CHAR(64) NULL;

-- Backfill the fingerprint for existing rows before any purge can null the
-- source text. SHA2(..., 256) matches the hex digest produced by sha256() in
-- src/types/task.ts.
UPDATE routing_log
   SET input_text_sha256 = SHA2(input_text, 256)
 WHERE input_text_sha256 IS NULL
   AND input_text IS NOT NULL;

ALTER TABLE routing_log MODIFY input_text TEXT NULL;
