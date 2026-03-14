-- Add tool_use and vision capabilities to claude-sonnet-4-5.
-- Sonnet 4 supports both capabilities but they were missing from the initial seed.
UPDATE agent_registry
SET capabilities = '["code_generation","reasoning","structured_output","long_context","tool_use","vision"]'
WHERE agent_id = 'claude-sonnet-4-5';
