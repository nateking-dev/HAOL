-- Enforce "at most one active routing_policy" at the schema level. Nothing
-- previously stopped two rows from having active = TRUE, and getActivePolicy
-- uses LIMIT 1, so a second activation silently produced undefined routing.
--
-- The generated marker is 1 when active and NULL otherwise; a UNIQUE key on it
-- permits unlimited NULLs (inactive rows) but only a single 1. A second INSERT
-- or an UPDATE that flips another row to active then fails the unique check
-- (Dolt: "duplicate unique key given: [1]"). Verified against Dolt 2.1.4.
--
-- Two statements rather than one combined ALTER so a crash between them
-- recovers cleanly: re-run hits ER_DUP_FIELDNAME (1060) on the column and
-- ER_DUP_KEYNAME (1061) on the key, both allow-listed as recoverable in
-- migrate.ts. If a populated DB already holds two active rows, ADD UNIQUE KEY
-- fails with a real duplicate — intended: the operator must fix the data first.
ALTER TABLE routing_policy
  ADD COLUMN is_active_marker TINYINT GENERATED ALWAYS AS (IF(active, 1, NULL)) STORED;

ALTER TABLE routing_policy
  ADD UNIQUE KEY uk_one_active (is_active_marker);
