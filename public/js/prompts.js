// HAOL Demo — Pre-scripted demo prompts

const DEMO_PROMPTS = [
  {
    label: "The Gimme",
    prompt: "Summarize this paragraph about renewable energy adoption in developing nations.",
    description: "Deterministic rules catch 'summariz' instantly. No API call needed.",
  },
  {
    label: "The Curveball",
    prompt: "Pull out the key points from this customer feedback report.",
    description: "No trigger words. Semantic similarity resolves it by understanding intent.",
  },
  {
    label: "The Ambiguous One",
    prompt: "Given these constraints, what would be the most pragmatic way to solve this?",
    description: "Too vague for rules or embeddings. Escalates to LLM classification.",
  },
  {
    label: "The Heavy Hitter",
    prompt: "Analyze this screenshot of a dashboard and generate the corresponding React component with TypeScript types.",
    description: "Multi-capability routing: vision + code + reasoning. Where naive systems break down.",
  },
  {
    label: "The Escalator",
    prompt: "Look at the attached UI mockup and write the React component that reproduces it, including proper TypeScript interfaces for the props.",
    description: "Dodges every keyword rule and embedding match. Forces LLM escalation to classify.",
  },
];
