-- Fix routing rule regex patterns that use trailing \b word boundaries on partial stems.
-- Patterns like \b(classif|categoriz|label)\b fail to match "Classify" or "Categorize"
-- because there is no word boundary between the stem and the remaining characters.
-- Align DB patterns with the working patterns in src/classifier/rules.ts:
-- use trailing \b only on whole words, not partial stems.

UPDATE routing_rules SET pattern = '\\b(classif|categoriz|label\\b)'
WHERE rule_id = 'rule-classify';

UPDATE routing_rules SET pattern = '\\b(code\\b|implement|function\\b|debug\\b|refactor)'
WHERE rule_id = 'rule-code';

UPDATE routing_rules SET pattern = '\\b(analyz|analys|compar|reason|evaluat)'
WHERE rule_id = 'rule-reasoning';

UPDATE routing_rules SET pattern = '\\b(image\\b|screenshot\\b|diagram\\b|photo\\b)'
WHERE rule_id = 'rule-vision';

UPDATE routing_rules SET pattern = '\\b(json\\b|schema\\b|structured\\b|table\\b)'
WHERE rule_id = 'rule-structured';

UPDATE routing_rules SET pattern = '\\bentire\\b.*\\bdocument'
WHERE rule_id = 'rule-longctx';

UPDATE routing_rules SET pattern = '\\b(tool\\b|api\\b.*\\bcall\\b|function.call)'
WHERE rule_id = 'rule-tooluse';
