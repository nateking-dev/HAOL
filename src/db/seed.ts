import { loadConfig } from "../config.js";
import { createPool, getPool, destroy } from "./connection.js";
import { doltCommit } from "./dolt.js";

const SEED_ROUTING_TIERS = `
INSERT IGNORE INTO routing_tiers (tier_id, tier_name, description, default_agent) VALUES
  (1, 'Simple', 'Basic tasks: summarization, classification, simple Q&A', 'local-llama'),
  (2, 'Moderate', 'Moderate tasks: structured output, translation, multi-step reasoning', 'gpt-4o-mini'),
  (3, 'Complex', 'Complex tasks: code generation, analysis, long-context reasoning', 'claude-sonnet-4-5'),
  (4, 'Expert', 'Expert tasks: multi-capability, vision, tool use, advanced reasoning', 'claude-opus-4-6')
`;

const SEED_ROUTING_RULES = `
INSERT IGNORE INTO routing_rules (rule_id, tier_id, rule_type, pattern, capabilities, priority, description) VALUES
  ('rule-summarize', 1, 'regex', '\\\\bsummariz', '["summarization"]', 10, 'Summarization tasks'),
  ('rule-classify', 1, 'regex', '\\\\b(classif|categoriz|label\\\\b)', '["classification"]', 10, 'Classification tasks'),
  ('rule-code', 3, 'regex', '\\\\b(code\\\\b|implement|function\\\\b|debug\\\\b|refactor)', '["code_generation"]', 20, 'Code generation tasks'),
  ('rule-reasoning', 3, 'regex', '\\\\b(analyz|analys|compar|reason|evaluat)', '["reasoning"]', 20, 'Reasoning tasks'),
  ('rule-vision', 3, 'regex', '\\\\b(image\\\\b|screenshot\\\\b|diagram\\\\b|photo\\\\b)', '["vision"]', 20, 'Vision tasks'),
  ('rule-structured', 2, 'regex', '\\\\b(json\\\\b|schema\\\\b|structured\\\\b|table\\\\b)', '["structured_output"]', 15, 'Structured output tasks'),
  ('rule-longctx', 3, 'regex', '\\\\bentire\\\\b.*\\\\bdocument\\\\b', '["long_context"]', 20, 'Long context tasks'),
  ('rule-tooluse', 3, 'regex', '\\\\b(tool\\\\b|api\\\\b.*\\\\bcall\\\\b|function.call)', '["tool_use"]', 20, 'Tool use tasks'),
  ('rule-multilingual', 2, 'regex', '\\\\b(translat|multilingual)', '["multilingual"]', 15, 'Multilingual tasks')
`;

const SEED_ROUTER_CONFIG = `
INSERT IGNORE INTO router_config (config_key, config_value, description) VALUES
  ('embedding_model', 'text-embedding-3-small', 'OpenAI model for runtime embeddings'),
  ('embedding_dimensions', '512', 'Shortened embedding dimensionality'),
  ('similarity_threshold', '0.72', 'Min cosine similarity to accept a route'),
  ('escalation_threshold', '0.55', 'Below this, escalate to LLM classifier'),
  ('escalation_model', 'claude-haiku-4-5-20251001', 'Model for Layer 2 escalation'),
  ('default_tier', '3', 'Fallback tier when routing is uncertain'),
  ('top_k', '5', 'Number of nearest utterances to consider'),
  ('enable_escalation', 'true', 'Whether Layer 2 LLM escalation is active'),
  ('confidence_threshold', '0.6', 'Confidence below which routing decisions are sampled for LLM evaluation')
`;

const SEED_ROUTING_UTTERANCES = `
INSERT IGNORE INTO routing_utterances (utterance_id, tier_id, utterance_text, embedding, embedding_model, embedding_dim, source) VALUES
  ('utt-t1-01', 1, 'Summarize this paragraph in one sentence', '[]', 'pending', 0, 'manual'),
  ('utt-t1-02', 1, 'What is the capital of France?', '[]', 'pending', 0, 'manual'),
  ('utt-t1-03', 1, 'Classify this email as spam or not spam', '[]', 'pending', 0, 'manual'),
  ('utt-t1-04', 1, 'Extract the main topics from this text', '[]', 'pending', 0, 'manual'),
  ('utt-t1-05', 1, 'Translate hello to Spanish', '[]', 'pending', 0, 'manual'),
  ('utt-t1-06', 1, 'List the key points from this article', '[]', 'pending', 0, 'manual'),
  ('utt-t1-07', 1, 'Rewrite this sentence to be more concise', '[]', 'pending', 0, 'manual'),
  ('utt-t1-08', 1, 'What does this acronym stand for?', '[]', 'pending', 0, 'manual'),
  ('utt-t2-01', 2, 'Convert this CSV data into a formatted JSON schema', '[]', 'pending', 0, 'manual'),
  ('utt-t2-02', 2, 'Compare these two product descriptions and highlight differences', '[]', 'pending', 0, 'manual'),
  ('utt-t2-03', 2, 'Write a professional email response to this customer complaint', '[]', 'pending', 0, 'manual'),
  ('utt-t2-04', 2, 'Create a table summarizing the pros and cons of each option', '[]', 'pending', 0, 'manual'),
  ('utt-t2-05', 2, 'Translate this legal document from English to French', '[]', 'pending', 0, 'manual'),
  ('utt-t2-06', 2, 'Generate a structured report from these meeting notes', '[]', 'pending', 0, 'manual'),
  ('utt-t2-07', 2, 'Analyze the sentiment of these customer reviews', '[]', 'pending', 0, 'manual'),
  ('utt-t2-08', 2, 'Rewrite this technical documentation for a non-technical audience', '[]', 'pending', 0, 'manual'),
  ('utt-t3-01', 3, 'Write a Python function that implements binary search with error handling', '[]', 'pending', 0, 'manual'),
  ('utt-t3-02', 3, 'Analyze this codebase and suggest architectural improvements', '[]', 'pending', 0, 'manual'),
  ('utt-t3-03', 3, 'Debug this React component that has a memory leak', '[]', 'pending', 0, 'manual'),
  ('utt-t3-04', 3, 'Refactor this legacy code to use modern async/await patterns', '[]', 'pending', 0, 'manual'),
  ('utt-t3-05', 3, 'Evaluate the security implications of this API design', '[]', 'pending', 0, 'manual'),
  ('utt-t3-06', 3, 'Write comprehensive unit tests for this service layer', '[]', 'pending', 0, 'manual'),
  ('utt-t3-07', 3, 'Explain the entire document and provide a detailed analysis', '[]', 'pending', 0, 'manual'),
  ('utt-t3-08', 3, 'Compare these three database schemas and recommend the best approach', '[]', 'pending', 0, 'manual'),
  ('utt-t4-01', 4, 'Build a full-stack application with authentication, API, and database layer', '[]', 'pending', 0, 'manual'),
  ('utt-t4-02', 4, 'Analyze this screenshot of a UI and generate the corresponding React code', '[]', 'pending', 0, 'manual'),
  ('utt-t4-03', 4, 'Design a microservices architecture with tool integrations for this system', '[]', 'pending', 0, 'manual'),
  ('utt-t4-04', 4, 'Review this entire codebase, identify bugs, and implement fixes with tests', '[]', 'pending', 0, 'manual'),
  ('utt-t4-05', 4, 'Create an API that calls external tools, handles errors, and generates structured output', '[]', 'pending', 0, 'manual'),
  ('utt-t4-06', 4, 'Translate and adapt this multilingual application with code generation and vision analysis', '[]', 'pending', 0, 'manual'),
  ('utt-t4-07', 4, 'Analyze this diagram, write the implementation code, and create integration tests', '[]', 'pending', 0, 'manual'),
  ('utt-t4-08', 4, 'Build an end-to-end data pipeline with monitoring, alerting, and documentation', '[]', 'pending', 0, 'manual')
`;

const SEED_ROUTING_POLICY = `
INSERT IGNORE INTO routing_policy
  (policy_id, weight_capability, weight_cost, weight_latency, fallback_strategy, max_retries, active)
VALUES
  ('default', 0.50, 0.30, 0.20, 'NEXT_BEST', 2, TRUE)
`;

const SEED_AGENTS = `
INSERT IGNORE INTO agent_registry
  (agent_id, provider, model_id, capabilities, cost_per_1k_input, cost_per_1k_output, max_context_tokens, avg_latency_ms, status, tier_ceiling)
VALUES
  ('claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5-20251001',
   '["classification","summarization","structured_output"]',
   0.000800, 0.004000, 200000, 300, 'active', 2),

  ('claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-20250514',
   '["code_generation","reasoning","structured_output","long_context","tool_use","vision"]',
   0.003000, 0.015000, 200000, 800, 'active', 3),

  ('gpt-4o-mini', 'openai', 'gpt-4o-mini',
   '["classification","summarization","structured_output","multilingual"]',
   0.000150, 0.000600, 128000, 400, 'active', 2),

  -- Pricing: $15/$75 per MTok (https://docs.anthropic.com/en/docs/about-claude/models)
  ('claude-opus-4-6', 'anthropic', 'claude-opus-4-6',
   '["code_generation","reasoning","structured_output","long_context","tool_use","vision","multilingual"]',
   0.015000, 0.075000, 1048576, 1200, 'active', 4),

  ('local-llama', 'local', 'llama-3.2-8b',
   '["summarization","classification"]',
   0.000000, 0.000000, 8192, 200, 'active', 1)
`;

async function seed() {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }

  const pool = getPool();

  console.log("Seeding routing policy...");
  await pool.query(SEED_ROUTING_POLICY);

  console.log("Seeding sample agents...");
  await pool.query(SEED_AGENTS);

  console.log("Seeding routing tiers...");
  await pool.query(SEED_ROUTING_TIERS);

  console.log("Seeding routing rules...");
  await pool.query(SEED_ROUTING_RULES);

  console.log("Seeding router config...");
  await pool.query(SEED_ROUTER_CONFIG);

  console.log("Seeding routing utterances...");
  await pool.query(SEED_ROUTING_UTTERANCES);

  await doltCommit({
    message: "seed: default routing policy + sample agents",
    author: "haol-seed <haol@system>",
  });

  console.log("Seed complete.");
  await destroy();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
