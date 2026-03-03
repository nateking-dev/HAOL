INSERT IGNORE INTO capability_taxonomy (capability_key, display_name, description, tier_minimum) VALUES
  ('long_context',      'Long Context',      'Ability to process large context windows (>32k tokens)', 2),
  ('structured_output', 'Structured Output', 'Reliable JSON/schema-conformant output generation',      1),
  ('code_generation',   'Code Generation',   'Writing, editing, and debugging source code',            2),
  ('summarization',     'Summarization',     'Condensing long text into concise summaries',            1),
  ('classification',    'Classification',    'Categorizing inputs into predefined labels',             1),
  ('vision',            'Vision',            'Processing and reasoning about images',                  2),
  ('tool_use',          'Tool Use',          'Invoking external tools and interpreting results',        3),
  ('reasoning',         'Reasoning',         'Multi-step logical reasoning and analysis',              2),
  ('multilingual',      'Multilingual',      'Understanding and generating text in multiple languages', 1);
