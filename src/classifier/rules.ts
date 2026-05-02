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
    // Tightened to require intent: strong code verbs alone, OR a generic
    // create-verb followed by a code/system noun within ~40 chars. See
    // migration 018_tighten_routing_rules.sql for full rationale.
    patterns: [
      /\b(implement|implements|implemented|implementing)\b/i,
      /\b(debug|debugs|debugged|debugging)\b/i,
      /\b(refactor|refactors|refactored|refactoring)\b/i,
      /\b(optimize|optimizes|optimized|optimizing)\b/i,
      /\b(write|writes|wrote|writing|create|creates|created|creating|build|builds|built|building|generate|generates|generated|generating|define|defines|defined|defining|fix|fixes|fixed|fixing)\b.{0,40}?\b(code|function|class|method|module|script|program|service|library|middleware|component|cli|api|endpoint|query)\b/i,
    ],
    capabilities: ["code_generation"],
    tierEffect: 1,
  },
  {
    name: "reasoning",
    // Verb forms only — noun forms (analysis, comparison, evaluation) are
    // descriptive, not intent-bearing.
    patterns: [
      /\b(analyze|analyzes|analyzing|analyzed|analyse|analyses|analysing|analysed)\b/i,
      /\b(compare|compares|comparing|compared)\b/i,
      /\b(evaluate|evaluates|evaluating|evaluated)\b/i,
      /\b(assess|assesses|assessing|assessed)\b/i,
      /\b(investigate|investigates|investigating|investigated)\b/i,
      /\b(reason|reasons|reasoning|reasoned)\b/i,
      /\b(examine|examines|examining|examined)\b/i,
    ],
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
    // Direct phrase matches for unambiguous tool-use signals, OR an action
    // verb pointed at a tool/api/function noun within ~40 chars.
    patterns: [
      /\bapi[\s._]call\b/i,
      /\bfunction[\s._]call\b/i,
      /\b(use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\b.{0,40}?\b(tool|api|function)\b/i,
    ],
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
    patterns: [
      /\bstep.by.step\b/i,
      /\bmulti.step\b/i,
      /\bphase[sd]?\b/i,
      /\bpipeline\b/i,
      /\bworkflow\b/i,
    ],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
  {
    name: "diagnostic",
    patterns: [
      /\broot.cause\b/i,
      /\bdiagnos/i,
      /\btroubleshoot/i,
      /\bintermittent\b/i,
      /\binvestigat/i,
    ],
    capabilities: ["reasoning"],
    tierEffect: 1,
  },
  {
    name: "system_design",
    patterns: [
      /\barchitect/i,
      /\bsystem.design\b/i,
      /\bmicroservice/i,
      /\bscalab/i,
      /\bdistributed\b/i,
    ],
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
