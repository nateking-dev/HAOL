import { describe, it, expect, vi, beforeEach } from "vitest";
import { CascadeRouter } from "../../src/cascade-router/cascade-router.js";
import type {
  EmbeddingProvider,
  EscalationProvider,
  TierId,
  LayerAttempt,
  CascadeTrace,
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
  confidence_threshold: 0.6,
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

function expectTraceShape(trace: CascadeTrace) {
  expect(trace).toBeDefined();
  expect(trace.layers).toHaveLength(4);
  expect(trace.layers.map((l) => l.layer)).toEqual([
    "deterministic",
    "semantic",
    "escalation",
    "fallback",
  ]);
  expect(typeof trace.total_latency_ms).toBe("number");
  expect(trace.total_latency_ms).toBeGreaterThanOrEqual(0);

  for (const attempt of trace.layers) {
    expect(["matched", "missed", "skipped", "error"]).toContain(attempt.status);
    expect(typeof attempt.reason).toBe("string");
    expect(attempt.reason.length).toBeGreaterThan(0);
  }

  // Exactly one layer should be the resolved layer
  const matched = trace.layers.filter((l) => l.status === "matched");
  expect(matched).toHaveLength(1);
  expect(matched[0].layer).toBe(trace.resolved_layer);
}

describe("CascadeTrace", () => {
  describe("trace shape", () => {
    it("always contains all 4 layers in order", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);
      mockLoadConfig.mockResolvedValue({ ...defaultConfig, enable_escalation: false });

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello world" });

      expectTraceShape(result.cascade_trace!);
    });

    it("attaches trace to TaskClassification", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello" });

      expect(result.cascade_trace).toBeDefined();
      expect(result.cascade_trace!.resolved_layer).toBeDefined();
    });
  });

  describe("metadata override trace", () => {
    it("shows deterministic matched, rest skipped", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);

      const router = await CascadeRouter.create();
      const result = await router.classify({
        prompt: "Hello",
        metadata: { tier: 2 },
      });

      const trace = result.cascade_trace!;
      expectTraceShape(trace);
      expect(trace.resolved_layer).toBe("deterministic");
      expect(trace.layers[0].status).toBe("matched");
      expect(trace.layers[0].tier).toBe(2);
      expect(trace.layers[0].reason).toContain("metadata");
      expect(trace.layers[1].status).toBe("skipped");
      expect(trace.layers[2].status).toBe("skipped");
      expect(trace.layers[3].status).toBe("skipped");
    });
  });

  describe("deterministic layer trace", () => {
    it("shows deterministic matched when rule hits", async () => {
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
      const result = await router.classify({ prompt: "Format as json" });

      const trace = result.cascade_trace!;
      expectTraceShape(trace);
      expect(trace.resolved_layer).toBe("deterministic");
      expect(trace.layers[0].status).toBe("matched");
      expect(trace.layers[0].confidence).toBe(1.0);
      expect(trace.layers[0].tier).toBe(2);
      expect(trace.layers[0].latency_ms).toBeGreaterThanOrEqual(0);
    });

    it("shows deterministic missed when no rules match", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);
      mockLoadConfig.mockResolvedValue({ ...defaultConfig, enable_escalation: false });

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello world" });

      const trace = result.cascade_trace!;
      expect(trace.layers[0].status).toBe("missed");
      expect(trace.layers[0].confidence).toBeNull();
      expect(trace.layers[0].tier).toBeNull();
      expect(trace.layers[0].reason).toBe("no rules matched");
    });
  });

  describe("semantic layer trace", () => {
    it("shows semantic matched when confidence exceeds threshold", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 2 as TierId, utterance_text: "test", embedding: [1, 0, 0] },
        {
          utterance_id: "u2",
          tier_id: 2 as TierId,
          utterance_text: "test2",
          embedding: [0.9, 0.1, 0],
        },
      ]);

      const embedder = mockEmbedder([1, 0, 0]);
      const router = await CascadeRouter.create({ embeddingProvider: embedder });
      const result = await router.classify({ prompt: "some query" });

      const trace = result.cascade_trace!;
      expectTraceShape(trace);
      expect(trace.resolved_layer).toBe("semantic");
      expect(trace.layers[0].status).toBe("missed");
      expect(trace.layers[1].status).toBe("matched");
      expect(trace.layers[1].confidence).toBeGreaterThanOrEqual(0.72);
      expect(trace.layers[1].similarity_score).not.toBeNull();
      expect(trace.layers[2].status).toBe("skipped");
      expect(trace.layers[3].status).toBe("skipped");
    });

    it("shows semantic missed when confidence below threshold", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 1 as TierId, utterance_text: "test1", embedding: [1, 0, 0] },
        { utterance_id: "u2", tier_id: 2 as TierId, utterance_text: "test2", embedding: [0, 1, 0] },
        { utterance_id: "u3", tier_id: 3 as TierId, utterance_text: "test3", embedding: [0, 0, 1] },
      ]);

      const embedder = mockEmbedder([0.577, 0.577, 0.577]);
      const escalation = mockEscalation(4 as TierId, [], 0.9);
      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
        escalationProvider: escalation,
      });
      const result = await router.classify({ prompt: "ambiguous" });

      const trace = result.cascade_trace!;
      expect(trace.layers[1].status).toBe("missed");
      expect(trace.layers[1].reason).toContain("< threshold");
    });

    it("shows semantic skipped when no utterances", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);
      mockLoadConfig.mockResolvedValue({ ...defaultConfig, enable_escalation: false });

      const router = await CascadeRouter.create();
      const result = await router.classify({ prompt: "Hello" });

      const trace = result.cascade_trace!;
      expect(trace.layers[1].status).toBe("skipped");
      expect(trace.layers[1].reason).toContain("no reference utterances");
    });
  });

  describe("escalation layer trace", () => {
    it("shows escalation matched after semantic miss", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 1 as TierId, utterance_text: "test", embedding: [1, 0, 0] },
        { utterance_id: "u2", tier_id: 2 as TierId, utterance_text: "test2", embedding: [0, 1, 0] },
        { utterance_id: "u3", tier_id: 3 as TierId, utterance_text: "test3", embedding: [0, 0, 1] },
      ]);

      const embedder = mockEmbedder([0.577, 0.577, 0.577]);
      const escalation = mockEscalation(4 as TierId, ["vision"], 0.85);
      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
        escalationProvider: escalation,
      });
      const result = await router.classify({ prompt: "complex task" });

      const trace = result.cascade_trace!;
      expectTraceShape(trace);
      expect(trace.resolved_layer).toBe("escalation");
      expect(trace.layers[0].status).toBe("missed");
      expect(trace.layers[1].status).toBe("missed");
      expect(trace.layers[2].status).toBe("matched");
      expect(trace.layers[2].confidence).toBe(0.85);
      expect(trace.layers[2].tier).toBe(4);
      expect(trace.layers[3].status).toBe("skipped");
    });

    it("shows escalation skipped when disabled", async () => {
      mockLoadConfig.mockResolvedValue({ ...defaultConfig, enable_escalation: false });
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 1 as TierId, utterance_text: "test", embedding: [1, 0, 0] },
      ]);

      const embedder = mockEmbedder([0, 1, 0]);
      const router = await CascadeRouter.create({ embeddingProvider: embedder });
      const result = await router.classify({ prompt: "something" });

      const trace = result.cascade_trace!;
      expect(trace.layers[2].status).toBe("skipped");
      expect(trace.layers[2].reason).toContain("escalation disabled");
    });

    it("shows escalation error when provider throws", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 1 as TierId, utterance_text: "test", embedding: [1, 0, 0] },
        { utterance_id: "u2", tier_id: 2 as TierId, utterance_text: "test2", embedding: [0, 1, 0] },
      ]);

      const embedder = mockEmbedder([0.577, 0.577, 0.577]);
      const escalation: EscalationProvider = {
        classify: vi.fn().mockRejectedValue(new Error("API timeout")),
      };
      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
        escalationProvider: escalation,
      });
      const result = await router.classify({ prompt: "something" });

      const trace = result.cascade_trace!;
      expect(trace.layers[2].status).toBe("error");
      expect(trace.layers[2].reason).toContain("API timeout");
    });
  });

  describe("fallback layer trace", () => {
    it("shows fallback matched when all layers fail", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([
        { utterance_id: "u1", tier_id: 1 as TierId, utterance_text: "test", embedding: [1, 0, 0] },
        { utterance_id: "u2", tier_id: 2 as TierId, utterance_text: "test2", embedding: [0, 1, 0] },
      ]);

      const embedder = mockEmbedder([0.577, 0.577, 0.577]);
      const escalation: EscalationProvider = {
        classify: vi.fn().mockRejectedValue(new Error("fail")),
      };
      const router = await CascadeRouter.create({
        embeddingProvider: embedder,
        escalationProvider: escalation,
      });
      const result = await router.classify({ prompt: "something" });

      const trace = result.cascade_trace!;
      expectTraceShape(trace);
      expect(trace.resolved_layer).toBe("fallback");
      expect(trace.layers[0].status).toBe("missed");
      expect(trace.layers[1].status).toBe("missed");
      expect(trace.layers[2].status).toBe("error");
      expect(trace.layers[3].status).toBe("matched");
      expect(trace.layers[3].tier).toBe(3);
      expect(trace.layers[3].reason).toContain("T3");
    });
  });

  describe("trace in logDecision metadata", () => {
    it("passes cascade_trace in metadata to logDecision", async () => {
      mockLoadRules.mockResolvedValue([]);
      mockLoadUtterances.mockResolvedValue([]);
      mockLoadConfig.mockResolvedValue({ ...defaultConfig, enable_escalation: false });

      const router = await CascadeRouter.create();
      await router.classify({ prompt: "Hello" });

      expect(mockLogDecision).toHaveBeenCalledOnce();
      const metadataArg = mockLogDecision.mock.calls[0][7];
      expect(metadataArg).toBeDefined();
      expect(metadataArg!.cascade_trace).toBeDefined();
      const trace = metadataArg!.cascade_trace as CascadeTrace;
      expect(trace.layers).toHaveLength(4);
    });
  });
});

describe("Legacy classifier trace", () => {
  it("produces a trace with deterministic matched and rest skipped", async () => {
    const { classify } = await import("../../src/classifier/classifier.js");
    const result = classify({ prompt: "Summarize this text" });

    const trace = result.cascade_trace!;
    expect(trace).toBeDefined();
    expect(trace.layers).toHaveLength(4);
    expect(trace.resolved_layer).toBe("deterministic");
    expect(trace.layers[0].status).toBe("matched");
    expect(trace.layers[0].layer).toBe("deterministic");
    expect(trace.layers[0].confidence).toBe(1.0);
    expect(trace.layers[0].reason).toContain("legacy");
    expect(trace.layers[1].status).toBe("skipped");
    expect(trace.layers[2].status).toBe("skipped");
    expect(trace.layers[3].status).toBe("skipped");
    expect(trace.total_latency_ms).toBeGreaterThanOrEqual(0);
  });
});
