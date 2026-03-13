import { describe, it, expect } from "vitest";
import { rules, matchRules } from "../../src/classifier/rules.js";

describe("rules", () => {
  describe("individual rule matching", () => {
    it("summarize_extract matches summarization keywords", () => {
      const rule = rules.find((r) => r.name === "summarize_extract")!;
      expect(rule.patterns.some((p) => p.test("Summarize this text"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Extract the key points"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Condense the report"))).toBe(
        true,
      );
    });

    it("classify matches classification keywords", () => {
      const rule = rules.find((r) => r.name === "classify")!;
      expect(rule.patterns.some((p) => p.test("Classify this item"))).toBe(
        true,
      );
      expect(
        rule.patterns.some((p) => p.test("Categorize these entries")),
      ).toBe(true);
      expect(rule.patterns.some((p) => p.test("Label the data"))).toBe(true);
    });

    it("code matches code-related keywords", () => {
      const rule = rules.find((r) => r.name === "code")!;
      expect(rule.patterns.some((p) => p.test("Write some code"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Implement a feature"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Define a function"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Debug this issue"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Refactor the module"))).toBe(
        true,
      );
    });

    it("reasoning matches reasoning keywords", () => {
      const rule = rules.find((r) => r.name === "reasoning")!;
      expect(rule.patterns.some((p) => p.test("Analyze the data"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Compare the options"))).toBe(
        true,
      );
      expect(
        rule.patterns.some((p) => p.test("Reason about the problem")),
      ).toBe(true);
      expect(rule.patterns.some((p) => p.test("Evaluate the approach"))).toBe(
        true,
      );
    });

    it("vision matches vision-related keywords", () => {
      const rule = rules.find((r) => r.name === "vision")!;
      expect(rule.patterns.some((p) => p.test("Describe this image"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Read the screenshot"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Interpret the diagram"))).toBe(
        true,
      );
      expect(
        rule.patterns.some((p) => p.test("Identify objects in the photo")),
      ).toBe(true);
    });

    it("structured_output matches structured output keywords", () => {
      const rule = rules.find((r) => r.name === "structured_output")!;
      expect(rule.patterns.some((p) => p.test("Return JSON"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Define a schema"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Give me structured data"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Format as a table"))).toBe(true);
    });

    it("long_context matches long context keywords", () => {
      const rule = rules.find((r) => r.name === "long_context")!;
      expect(
        rule.patterns.some((p) => p.test("Read the entire document")),
      ).toBe(true);
      expect(rule.patterns.some((p) => p.test("Process the full text"))).toBe(
        true,
      );
    });

    it("tool_use matches tool use keywords", () => {
      const rule = rules.find((r) => r.name === "tool_use")!;
      expect(rule.patterns.some((p) => p.test("Use a tool to search"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Make an API call"))).toBe(true);
      expect(rule.patterns.some((p) => p.test("Use function_call"))).toBe(true);
    });

    it("multilingual matches multilingual keywords", () => {
      const rule = rules.find((r) => r.name === "multilingual")!;
      expect(rule.patterns.some((p) => p.test("Translate this text"))).toBe(
        true,
      );
      expect(rule.patterns.some((p) => p.test("Multilingual support"))).toBe(
        true,
      );
    });
  });

  describe("rules do not match unrelated text", () => {
    it("summarize_extract does not match unrelated text", () => {
      const rule = rules.find((r) => r.name === "summarize_extract")!;
      expect(rule.patterns.some((p) => p.test("Hello world"))).toBe(false);
    });

    it("code does not match unrelated text", () => {
      const rule = rules.find((r) => r.name === "code")!;
      expect(
        rule.patterns.some((p) => p.test("Translate this to French")),
      ).toBe(false);
    });

    it("vision does not match unrelated text", () => {
      const rule = rules.find((r) => r.name === "vision")!;
      expect(rule.patterns.some((p) => p.test("Summarize the article"))).toBe(
        false,
      );
    });

    it("multilingual does not match unrelated text", () => {
      const rule = rules.find((r) => r.name === "multilingual")!;
      expect(rule.patterns.some((p) => p.test("Debug this function"))).toBe(
        false,
      );
    });
  });

  describe("matchRules", () => {
    it("returns deduplicated capabilities", () => {
      // "code" and "refactor" both trigger the code rule, but should only add code_generation once
      const result = matchRules("Write code and refactor the module");
      const codeGenCount = result.capabilities.filter((c) => c === "code_generation").length;
      expect(codeGenCount).toBe(1);
    });

    it("returns combined tierBump from all matched rules", () => {
      // "Analyze" triggers reasoning (tierEffect 1), "implement" triggers code (tierEffect 1)
      // Sum should be 2
      const result = matchRules("Analyze and implement");
      expect(result.tierBump).toBe(2);
    });

    it("returns empty capabilities and zero tierBump for non-matching text", () => {
      const result = matchRules("Hello");
      expect(result.capabilities).toEqual([]);
      expect(result.tierBump).toBe(0);
    });

    it("matches multiple rules and merges capabilities", () => {
      const result = matchRules("Classify this image and return JSON");
      expect(result.capabilities).toEqual(
        expect.arrayContaining([
          "classification",
          "vision",
          "structured_output",
        ]),
      );
    });
  });
});
