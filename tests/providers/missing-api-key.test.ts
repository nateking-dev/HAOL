import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { MissingApiKeyError } from "../../src/providers/errors.js";

const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIG_OPENAI = process.env.OPENAI_API_KEY;

function restore(key: string, original: string | undefined) {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

describe("provider constructor — missing API key", () => {
  afterEach(() => {
    restore("ANTHROPIC_API_KEY", ORIG_ANTHROPIC);
    restore("OPENAI_API_KEY", ORIG_OPENAI);
  });

  describe("AnthropicProvider", () => {
    it("throws MissingApiKeyError when ANTHROPIC_API_KEY is unset", () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(() => new AnthropicProvider("claude-haiku-4-5-20251001")).toThrow(MissingApiKeyError);
    });

    it("throws MissingApiKeyError when ANTHROPIC_API_KEY is empty string", () => {
      process.env.ANTHROPIC_API_KEY = "";
      expect(() => new AnthropicProvider("claude-haiku-4-5-20251001")).toThrow(MissingApiKeyError);
    });

    it("includes the env var name on the error so operators know what to set", () => {
      delete process.env.ANTHROPIC_API_KEY;
      try {
        new AnthropicProvider("claude-haiku-4-5-20251001");
        expect.fail("expected constructor to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingApiKeyError);
        const e = err as MissingApiKeyError;
        expect(e.envVar).toBe("ANTHROPIC_API_KEY");
        expect(e.providerName).toBe("Anthropic");
        expect(e.message).toContain("ANTHROPIC_API_KEY");
      }
    });

    it("constructs successfully when the key is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      expect(() => new AnthropicProvider("claude-haiku-4-5-20251001")).not.toThrow();
    });
  });

  describe("OpenAIProvider", () => {
    it("throws MissingApiKeyError when OPENAI_API_KEY is unset", () => {
      delete process.env.OPENAI_API_KEY;
      expect(() => new OpenAIProvider("gpt-4o")).toThrow(MissingApiKeyError);
    });

    it("throws MissingApiKeyError when OPENAI_API_KEY is empty string", () => {
      process.env.OPENAI_API_KEY = "";
      expect(() => new OpenAIProvider("gpt-4o")).toThrow(MissingApiKeyError);
    });

    it("includes the env var name on the error so operators know what to set", () => {
      delete process.env.OPENAI_API_KEY;
      try {
        new OpenAIProvider("gpt-4o");
        expect.fail("expected constructor to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingApiKeyError);
        const e = err as MissingApiKeyError;
        expect(e.envVar).toBe("OPENAI_API_KEY");
        expect(e.providerName).toBe("OpenAI");
      }
    });

    it("constructs successfully when the key is set", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      expect(() => new OpenAIProvider("gpt-4o")).not.toThrow();
    });
  });
});
