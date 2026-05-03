-- Migration 010 declared task_outcome.signal_value as TINYINT DEFAULT NULL,
-- but Dolt interpreted that as NOT NULL DEFAULT NULL (DESCRIBE shows
-- Null=NO). The application has always treated this column as nullable —
-- TaskOutcomeRecord.signal_value is number|null, repository INSERTs pass
-- through nulls, and queries filter signal_value IS NOT NULL. The schema
-- was the only thing disagreeing.
--
-- Two test cases need NULLs to round-trip: the evaluation_pending /
-- evaluation_failed outcome records inserted by outcome-collector when an
-- LLM eval is in flight or has failed, and the seed data for
-- outcomeSignalRates which verifies pending rows are excluded.

ALTER TABLE task_outcome MODIFY signal_value TINYINT NULL DEFAULT NULL;
