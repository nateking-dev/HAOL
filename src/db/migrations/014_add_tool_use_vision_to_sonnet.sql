-- Add tool_use and vision capabilities to claude-sonnet-4-5.
-- Sonnet 4 supports both capabilities but they were missing from the initial seed.
-- Split into separate statements so each capability is added independently —
-- if one already exists, the other is still applied.
-- NOTE: Requires claude-sonnet-4-5 to already exist in agent_registry (run npm run seed first).

UPDATE agent_registry
SET capabilities = JSON_ARRAY_APPEND(capabilities, '$', 'tool_use')
WHERE agent_id = 'claude-sonnet-4-5'
  AND NOT JSON_CONTAINS(capabilities, '"tool_use"');

UPDATE agent_registry
SET capabilities = JSON_ARRAY_APPEND(capabilities, '$', 'vision')
WHERE agent_id = 'claude-sonnet-4-5'
  AND NOT JSON_CONTAINS(capabilities, '"vision"');
