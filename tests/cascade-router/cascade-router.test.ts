import { describe, it, expect, vi, beforeEach } from "vitest";
import { CascadeRouter } from "../../src/cascade-router/cascade-router.js";
import type {
  EmbeddingProvider,
  EscalationProvider,
  TierId,
  TierDefinition,
} from "../../src/cascade-router/types.js";

// Mock DB layer
vi.mock("../../src/cascade-router/reference-store.js", () => ({
  loadRules: vi.fn(),
  loadUtterances: vi.fn(),
  loadConfig: vi.fn(),
  logDecision: vi.fn().mockResolvedValue(undefined),
  hasEmbeddings: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/db/connection.js", () => ({
  query: vi.fn().mockResolvedValue([
    { tier_id: 1, tier_name: "Simple", description: "Basic tasks", default_agent: "local-llama" },
    {
      tier_id: 2,
      tier_name: "Moderate",
      description: "Moderate tasks",
      default_agent: "gpt-4o-mini",
    },
    {
      tier_id: 3,
      tier_name: "Complex",
      description: "Complex tasks",
      default_agent: "claude-sonnet-4-5",
    },
    {
      tier_id: 4,
      tier_name: "Expert",
      description: "Expert tasks",
      default_agent: "claude-sonnet-4-5",
    },
  ]),
  execute: vi.fn(),
}));

import * as store from "../../src/cascade-router/reference-store.js";

const mockLoadRules = vi.mocked(store.loadRules);
const mockLoadUtterances = vi.mocked(store.loadUtterances);
const mockLoadConfig = vi.mocked(store.loadConfig);
const mockLogDecision = vi.mocked(store.logDecision);

const defaultConfig = {
  embedding_model: "text-embedding-3-small",
  embedding_dimensions: 512,
  similarity_threshold: 0.72,
  escalation_threshold: 0.55,
  escalation_model: "claude-haiku-4-5-20251001",
  default_tier: 3 as TierId,
  top_k: 5,
  enable_escalation: true,
};

function mockEmbedder(embedding: number[]): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue(embedding),
    modelId: () => "test-model",
    dimensions: () => embedding.length,
  };
}

function mockEscalation(
  tier: TierId,
  capabilities: string[] = [],
  confidence = 0.8,
): EscalationProvider {
  return {
    classify: vi.fn().mockResolvedValue({ tier, capabilities, confidence }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue(defaultConfig);
});

describe("CascadeRouter", () => {
  describe("metadata override", () => {
    it("uses metadata tier override directly", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Hello world",
        metadata: { tier: 4 },
      });

      expect(result.complexity_tier).toBe(4);
      expect(result.cost_ceiling_usd).toBe(5.0);
    });

    it("merges metadata capabilities", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Summarize this text",
        metadata: { tier: 1, capabilities: ["custom_cap"] },
      });

      expect(result.required_capabilities).toContain("summarization");
      expect(result.required_capabilities).toContain("custom_cap");
    });
  });

  describe("Layer 0 — deterministic rules", () => {
    it("matches regex rules and uses highest tier", async () => {
      mockLoadRules.mockResolvedValue([
        {
          rule_id: "r1",
          tier_id: 1 as TierId,
          rule_type: "regex",
          pattern: "\\bsummariz",
          capabilities: ["summarization"],
          priority: 10,
          enabled: true,
          description: null,
        },
        {
          rule_id: "r2",
          tier_id: 3 as TierId,
          rule_type: "regex",
          pattern: "\\bcode\\b",
          capabilities: ["code_generation"],
          priority: 20,
          enabled: true,
          description: null,
        },
      ]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Summarize and write code for this",
      });

      expect(result.complexity_tier).toBe(3);
      expect(result.required_capabilities).toContain("summarization");
      expect(result.required_capabilities).toContain("code_generation");
    });

    it("matches prefix rules", async () => {
      mockLoadRules.mockResolvedValue([
        {
          rule_id: "r1",
          tier_id: 1 as TierId,
          rule_type: "prefix",
          pattern: "translate",
          capabilities: ["multilingual"],
          priority: 10,
          enabled: true,
          description: null,
        },
      ]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Translate this to French",
      });

      expect(result.complexity_tier).toBe(1);
    });

    it("rejects unsafe regex without logging the pattern", async () => {
      const unsafePattern = "(a+)+$";
      mockLoadRules.mockResolvedValue([
        {
          rule_id: "r-unsafe",
          tier_id: 1 as TierId,
          rule_type: "regex",
          pattern: unsafePattern,
          capabilities: ["summarization"],
          priority: 10,
          enabled: true,
          description: null,
        },
      ]);
      mockLoadUtterances.mockResolvedValue([]);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const router = await CascadeRouter.create();
      await router.classify({ prompt: "aaaaaa" });

      expect(warnSpy).toHaveBeenCalledOnce();
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).toContain("r-unsafe");
      expect(message).not.toContain(unsafePattern);
      warnSpy.mockRestore();
    });

    it("matches contains rules", async () => {
      mockLoadRules.mockResolvedValue([
        {
          rule_id: "r1",
          tier_id: 2 as TierId,
          rule_type: "contains",
          pattern: "json",
          capabilities: ["structured_output"],
          priority: 10,
          enabled: true,
          description: null,
        },
      ]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Format this as json please",
      });

      expect(result.complexity_tier).toBe(2);
    });
  });

  describe("Layer 0 — seed rule patterns match inflected forms", () => {
    // These tests use the actual patterns from SEED_ROUTING_RULES to verify
    // they correctly match common inflected forms (the original patterns had
    // trailing \b word boundaries that broke partial stem matching).
    const seedRules = [
      {
        rule_id: "rule-classify",
        tier_id: 1 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(classif|categoriz|label\\b)",
        capabilities: ["classification"],
        priority: 10,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-code",
        tier_id: 3 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(code\\b|implement|function\\b|debug\\b|refactor)",
        capabilities: ["code_generation"],
        priority: 20,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-reasoning",
        tier_id: 3 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(analyz|analys|compar|reason|evaluat)",
        capabilities: ["reasoning"],
        priority: 20,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-vision",
        tier_id: 3 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(image\\b|screenshot\\b|diagram\\b|photo\\b)",
        capabilities: ["vision"],
        priority: 20,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-structured",
        tier_id: 2 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(json\\b|schema\\b|structured\\b|table\\b)",
        capabilities: ["structured_output"],
        priority: 15,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-longctx",
        tier_id: 3 as TierId,
        rule_type: "regex" as const,
        pattern: "\\bentire\\b.*\\bdocument\\b",
        capabilities: ["long_context"],
        priority: 20,
        enabled: true,
        description: null,
      },
      {
        rule_id: "rule-tooluse",
        tier_id: 3 as TierId,
        rule_type: "regex" as const,
        pattern: "\\b(tool\\b|api\\b.*\\bcall\\b|function.call)",
        capabilities: ["tool_use"],
        priority: 20,
        enabled: true,
        description: null,
      },
    ];

    let router: InstanceType<typeof CascadeRouter>;

    beforeEach(async () => {
      mockLoadRules.mockResolvedValue(seedRules);
      mockLoadUtterances.mockResolvedValue([]);
      router = await CascadeRouter.create();
    });

    it("rule-classify matches 'Classify', 'Categorize', 'Classification'", async () => {
      for (const prompt of [
        "Classify this email as spam",
        "Categorize the sentiment",
        "Classification of support tickets",
      ]) {
        const result = await router.classify({ prompt });
        expect(result.complexity_tier).toBe(1);
        expect(result.required_capabilities).toContain("classification");
      }
    });

    it("rule-code matches 'Implement', 'Refactoring', 'Debug'", async () => {
      for (const prompt of ["Implement a cache", "Refactoring the module", "Debug this issue"]) {
        const result = await router.classify({ prompt });
        expect(result.complexity_tier).toBe(3);
        expect(result.required_capabilities).toContain("code_generation");
      }
    });

    it("rule-reasoning matches 'Analyze', 'Analysis', 'Comparison', 'Evaluate'", async () => {
      for (const prompt of [
        "Analyze the data",
        "Data analysis report",
        "Comparison of options",
        "Evaluate the approach",
      ]) {
        const result = await router.classify({ prompt });
        expect(result.complexity_tier).toBe(3);
        expect(result.required_capabilities).toContain("reasoning");
      }
    });

    it("rule-vision matches 'image', 'screenshot', 'diagram', 'photo'", async () => {
      for (const prompt of [
        "Describe this image",
        "Read the screenshot",
        "Interpret the diagram",
        "Identify objects in the photo",
      ]) {
        const result = await router.classify({ prompt });
        expect(result.complexity_tier).toBe(3);
        expect(result.required_capabilities).toContain("vision");
      }
    });

    it("rule-structured matches 'json', 'schema', 'structured', 'table'", async () => {
      for (const prompt of [
        "Return JSON output",
        "Define a schema",
        "Give me structured data",
        "Format as a table",
      ]) {
        const result = await router.classify({ prompt });
        expect(result.required_capabilities).toContain("structured_output");
      }
    });

    it("rule-longctx matches 'entire document'", async () => {
      const result = await router.classify({ prompt: "Read the entire document" });
      expect(result.complexity_tier).toBe(3);
      expect(result.required_capabilities).toContain("long_context");
    });

    it("rule-tooluse matches 'tool', 'API call', 'function call'", async () => {
      for (const prompt of [
        "Use a tool to search",
        "Make an API call",
        "Use function_call to invoke",
      ]) {
        const result = await router.classify({ prompt });
        expect(result.complexity_tier).toBe(3);
        expect(result.required_capabilities).toContain("tool_use");
      }
    });
  });

  describe("Layer 1 — semantic similarity", () => {
    it("uses embedding when no rules match and confidence is high", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        {
          utterance_id: "u1",
          tier_id: 2 as TierId,
          utterance_text: "test",
          embedding: [1, 0, 0],
        },
        {
          utterance_id: "u2",
          tier_id: 2 as TierId,
          utterance_text: "test2",
          embedding: [0.9, 0.1, 0],
        },
      ]);

      const embedder = mockEmbedder([1, 0, 0]);

      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
      });
      const result = await router.classify({ prompt: "some ambiguous query" });

      expect(result.complexity_tier).toBe(2);
      expect(embedder.embed).toHaveBeenCalledWith("some ambiguous query");
    });
  });

  describe("Layer 2 — LLM escalation", () => {
    it("escalates to LLM when similarity confidence is low", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        {
          utterance_id: "u1",
          tier_id: 1 as TierId,
          utterance_text: "test1",
          embedding: [1, 0, 0],
        },
        {
          utterance_id: "u2",
          tier_id: 2 as TierId,
          utterance_text: "test2",
          embedding: [0, 1, 0],
        },
        {
          utterance_id: "u3",
          tier_id: 3 as TierId,
          utterance_text: "test3",
          embedding: [0, 0, 1],
        },
      ]);

      // Embedding that's roughly equidistant → low confidence
      const embedder = mockEmbedder([0.577, 0.577, 0.577]);
      const escalation = mockEscalation(4 as TierId, ["vision"], 0.9);

      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
        escalationProvider: escalation,
      });
      const result = await router.classify({
        prompt: "ambiguous multi-domain task",
      });

      expect(result.complexity_tier).toBe(4);
      expect(result.required_capabilities).toContain("vision");
    });

    it("falls back to default tier when escalation is disabled", async () => {
      mockLoadConfig.mockResolvedValue({
        ...defaultConfig,
        enable_escalation: false,
      });
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        {
          utterance_id: "u1",
          tier_id: 1 as TierId,
          utterance_text: "test",
          embedding: [1, 0, 0],
        },
      ]);

      const embedder = mockEmbedder([0, 1, 0]);

      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
      });
      const result = await router.classify({ prompt: "something unknown" });

      expect(result.complexity_tier).toBe(3); // default_tier
    });
  });

  describe("fallback", () => {
    it("falls back to default tier when no layers available", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);
      mockLoadConfig.mockResolvedValue({
        ...defaultConfig,
        enable_escalation: false,
      });

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello world" });

      expect(result.complexity_tier).toBe(3);
    });
  });

  describe("capability aggregation", () => {
    it("combines regex capabilities with rule capabilities", async () => {
      mockLoadRules.mockResolvedValue([
        {
          rule_id: "r1",
          tier_id: 2 as TierId,
          rule_type: "contains",
          pattern: "json",
          capabilities: ["structured_output"],
          priority: 10,
          enabled: true,
          description: null,
        },
      ]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      // "Summarize" triggers regex rule from matchRules, "json" triggers DB rule
      const result = await router.classify({
        prompt: "Summarize this and output as json",
      });

      expect(result.required_capabilities).toContain("summarization");
      expect(result.required_capabilities).toContain("structured_output");
    });
  });

  describe("output shape", () => {
    it("returns valid TaskClassification", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello" });

      expect(result.task_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.complexity_tier).toBeGreaterThanOrEqual(1);
      expect(result.complexity_tier).toBeLessThanOrEqual(4);
      expect(Array.isArray(result.required_capabilities)).toBe(true);
      expect(typeof result.cost_ceiling_usd).toBe("number");
    });

    it("logs decision to routing_log", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      await router.classify({ prompt: "test" });

      expect(mockLogDecision).toHaveBeenCalledOnce();
    });
  });
});
