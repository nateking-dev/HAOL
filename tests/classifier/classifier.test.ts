import { describe, it, expect } from "vitest";
import { classify } from "../../src/classifier/classifier.js";
import fixtures from "./fixtures/prompts.json" with { type: "json" };

interface Fixture {
  prompt: string;
  expectedTier: number;
  expectedCapabilities: string[];
}

describe("classify", () => {
  describe("fixture-based tests", () => {
    for (const fixture of fixtures as Fixture[]) {
      it(`classifies "${fixture.prompt.slice(0, 50)}..." as tier ${fixture.expectedTier}`, () => {
        const result = classify({ prompt: fixture.prompt });
        expect(result.complexity_tier).toBe(fixture.expectedTier);
        expect(result.required_capabilities).toEqual(
          expect.arrayContaining(fixture.expectedCapabilities),
        );
      });
    }
  });

  describe("metadata overrides", () => {
    it("uses metadata tier override regardless of prompt", () => {
      const result = classify({
        prompt: "Hello",
        metadata: { tier: 4 },
      });
      expect(result.complexity_tier).toBe(4);
      expect(result.cost_ceiling_usd).toBe(5.0);
    });

    it("merges metadata capabilities with detected ones", () => {
      const result = classify({
        prompt: "Summarize this paragraph",
        metadata: { capabilities: ["custom_cap"] },
      });
      expect(result.required_capabilities).toContain("summarization");
      expect(result.required_capabilities).toContain("custom_cap");
    });

    it("does not duplicate capabilities from metadata", () => {
      const result = classify({
        prompt: "Summarize this paragraph",
        metadata: { capabilities: ["summarization"] },
      });
      const count = result.required_capabilities.filter(
        (c) => c === "summarization",
      ).length;
      expect(count).toBe(1);
    });
  });

  describe("prompt_hash", () => {
    it("is deterministic for the same input", () => {
      const result1 = classify({ prompt: "Hello world" });
      const result2 = classify({ prompt: "Hello world" });
      expect(result1.prompt_hash).toBe(result2.prompt_hash);
    });

    it("differs for different inputs", () => {
      const result1 = classify({ prompt: "Hello" });
      const result2 = classify({ prompt: "World" });
      expect(result1.prompt_hash).not.toBe(result2.prompt_hash);
    });

    it("is a valid SHA-256 hex string", () => {
      const result = classify({ prompt: "test" });
      expect(result.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("task_id", () => {
    it("is a valid UUID format", () => {
      const result = classify({ prompt: "test" });
      expect(result.task_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("generates unique IDs for each call", () => {
      const result1 = classify({ prompt: "test" });
      const result2 = classify({ prompt: "test" });
      expect(result1.task_id).not.toBe(result2.task_id);
    });
  });

  describe("cost ceiling", () => {
    it("returns 0.01 for tier 1", () => {
      const result = classify({ prompt: "Hello", metadata: { tier: 1 } });
      expect(result.cost_ceiling_usd).toBe(0.01);
    });

    it("returns 0.05 for tier 2", () => {
      const result = classify({ prompt: "Hello", metadata: { tier: 2 } });
      expect(result.cost_ceiling_usd).toBe(0.05);
    });

    it("returns 0.50 for tier 3", () => {
      const result = classify({ prompt: "Hello", metadata: { tier: 3 } });
      expect(result.cost_ceiling_usd).toBe(0.5);
    });

    it("returns 5.00 for tier 4", () => {
      const result = classify({ prompt: "Hello", metadata: { tier: 4 } });
      expect(result.cost_ceiling_usd).toBe(5.0);
    });
  });
});
