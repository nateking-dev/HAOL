-- Add tool_use and vision capabilities to claude-sonnet-4-5.
-- Sonnet 4 supports both capabilities but they were missing from the initial seed.
-- Uses JSON_ARRAY_APPEND to preserve any existing customizations.
-- NOT JSON_CONTAINS guards make this idempotent.
-- NOTE: Requires claude-sonnet-4-5 to already exist in agent_registry (run npm run seed first).
UPDATE agent_registry
SET capabilities = JSON_ARRAY_APPEND(
    JSON_ARRAY_APPEND(capabilities, '$', 'tool_use'),
    '$', 'vision'
)
WHERE agent_id = 'claude-sonnet-4-5'
  AND NOT JSON_CONTAINS(capabilities, '"tool_use"')
  AND NOT JSON_CONTAINS(capabilities, '"vision"');
