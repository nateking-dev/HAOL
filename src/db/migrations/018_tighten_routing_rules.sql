-- Tighten T3 routing rule patterns to require intent phrasing rather than
-- bare keyword matches. The previous patterns matched any incidental
-- mention of words like "function", "code", "analysis", "tool" — including
-- when those words appeared in the user's data rather than their
-- instructions — which over-routed simple T1/T2 prompts to T3.
--
-- Combined with migration to first-match-by-priority in the matcher (the
-- routing_rules.priority column was previously ignored for tier
-- determination), this should significantly reduce T3 over-escalation
-- surfaced by the load test's routing assertions and visible in
-- /observability/cascade.
--
-- Three guiding principles:
--   * Strong verbs (implement, debug, refactor, analyze) match alone —
--     they're almost always intent-bearing.
--   * Generic verbs (write, build, create) require a code/system noun
--     within ~4 tokens.
--   * Direct phrase matches preserved for unambiguous tool-use signals
--     (api call, function call).
--
-- Stems use explicit suffix groups instead of partial-stem matching to
-- avoid false positives on noun forms — "compare" matches but "comparison"
-- does not, "implement" matches but "implementation" does not.

-- rule-code (T3): strong code verbs alone, OR generic create-verb + code-noun.
-- The verb→noun gap uses .{0,40}? (lazy bounded character match) instead of
-- (?:[a-z]+\s+){0,N} because safe-regex rejects the latter — bounded outer
-- with unbounded + inner is its trigger for "potentially nested quantifier."
-- The lazy bound at 40 chars covers ~6-7 intervening words.
UPDATE routing_rules
SET pattern = '\\b(implement(s|ed|ing)?|debug(s|ged|ging)?|refactor(s|ed|ing)?|optimiz(e|es|ed|ing)?)\\b|\\b(write|writes|wrote|writing|create|creates|created|creating|build|builds|built|building|generate|generates|generated|generating|define|defines|defined|defining|fix|fixes|fixed|fixing)\\b.{0,40}?\\b(code|function|class|method|module|script|program|service|library|middleware|component|cli|api|endpoint|query)\\b'
WHERE rule_id = 'rule-code';

-- rule-reasoning (T3): verb forms only — drop noun forms like "analysis",
-- "comparison", "evaluation" that are descriptive rather than intent.
UPDATE routing_rules
SET pattern = '\\b(analyz(e|es|ed|ing)?|compar(e|es|ed|ing)?|evaluat(e|es|ed|ing)?|assess(es|ed|ing)?|investigat(e|es|ed|ing)?|reason(s|ed|ing)?|examin(e|es|ed|ing)?)\\b'
WHERE rule_id = 'rule-reasoning';

-- rule-tooluse (T3): direct phrase matches for unambiguous tool-use
-- signals, OR an action verb pointed at a tool/api/function noun.
UPDATE routing_rules
SET pattern = '\\b(api[\\s._]call|function[\\s._]call)\\b|\\b(use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\\b.{0,40}?\\b(tool|api|function)\\b'
WHERE rule_id = 'rule-tooluse';

-- rule-vision (T3): cleaner alternation, behavior unchanged. The vision
-- nouns are strongly intent-correlated so leaving them as bare-word
-- matches is appropriate.
UPDATE routing_rules
SET pattern = '\\b(image|screenshot|diagram|photo)\\b'
WHERE rule_id = 'rule-vision';
