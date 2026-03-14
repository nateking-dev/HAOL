export interface Rule {
  name: string;
  patterns: RegExp[];
  capabilities: string[];
  tierEffect: number;
}

export const rules: Rule[] = [
  {
    name: "summarize_extract",
    patterns: [/\bsummariz/i, /\bextract\b/i, /\bcondense\b/i],
    capabilities: ["summarization"],
    tierEffect: 0,
  },
  {
    name: "classify",
    patterns: [/\bclassif/i, /\bcategoriz/i, /\blabel\b/i],
    capabilities: ["classification"],
    tierEffect: 0,
  },
  {
    name: "code",
    patterns: [/\bcode\b/i, /\bimplement/i, /\bfunction\b/i, /\bdebug\b/i, /\brefactor/i],
    capabilities: ["code_generation"],
    tierEffect: 1,
  },
  {
    name: "reasoning",
    patterns: [/\banalyz/i, /\banalys/i, /\bcompar/i, /\breason/i, /\bevaluat/i],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
  {
    name: "vision",
    patterns: [/\bimage\b/i, /\bscreenshot\b/i, /\bdiagram\b/i, /\bphoto\b/i],
    capabilities: ["vision"],
    tierEffect: 1,
  },
  {
    name: "structured_output",
    patterns: [/\bjson\b/i, /\bschema\b/i, /\bstructured\b/i, /\btable\b/i],
    capabilities: ["structured_output"],
    tierEffect: 0,
  },
  {
    name: "long_context",
    patterns: [/\bentire\b.*\bdocument\b/i, /\bfull\b.*\btext\b/i],
    capabilities: ["long_context"],
    tierEffect: 1,
  },
  {
    name: "tool_use",
    patterns: [/\btool\b/i, /\bapi\b.*\bcall\b/i, /\bfunction.call/i],
    capabilities: ["tool_use"],
    tierEffect: 1,
  },
  {
    name: "multilingual",
    patterns: [/\btranslat/i, /\bmultilingual/i],
    capabilities: ["multilingual"],
    tierEffect: 0,
  },
  {
    name: "multi_step",
    patterns: [/\bstep.by.step\b/i, /\bmulti.step\b/i, /\bphase[sd]?\b/i, /\bpipeline\b/i, /\bworkflow\b/i, /\bcomplex\b/i],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
  {
    name: "diagnostic",
    patterns: [/\broot.cause\b/i, /\bdiagnos/i, /\btroubleshoot/i, /\bintermittent\b/i, /\binvestigat/i],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
  {
    name: "system_design",
    patterns: [/\barchitect/i, /\bsystem.design\b/i, /\bmicroservice/i, /\bscalab/i, /\bdistributed\b/i],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
];

export function matchRules(prompt: string): {
  capabilities: string[];
  tierBump: number;
} {
  const capabilitySet = new Set<string>();
  let totalTierBump = 0;

  for (const rule of rules) {
    const matched = rule.patterns.some((pattern) => pattern.test(prompt));
    if (matched) {
      for (const cap of rule.capabilities) {
        capabilitySet.add(cap);
      }
      totalTierBump += rule.tierEffect;
    }
  }

  return {
    capabilities: [...capabilitySet],
    tierBump: totalTierBump,
  };
}
