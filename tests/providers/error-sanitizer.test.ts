import { describe, it, expect } from "vitest";
import { formatProviderError } from "../../src/providers/error-sanitizer.js";

describe("formatProviderError", () => {
  it("includes only provider, status, and error.type when JSON has type", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "ignore me" },
    });
    expect(formatProviderError("Anthropic", 400, body)).toBe(
      "Anthropic API error 400 (invalid_request_error)",
    );
  });

  it("combines error.type and error.code with a slash", () => {
    const body = JSON.stringify({
      error: {
        message: "Rate limit reached for org-xxx",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    expect(formatProviderError("OpenAI", 429, body)).toBe(
      "OpenAI API error 429 (rate_limit_error/rate_limit_exceeded)",
    );
  });

  it("falls back to status-only when JSON has no recognizable error fields", () => {
    expect(formatProviderError("OpenAI", 502, '{"unrelated": "shape"}')).toBe(
      "OpenAI API error 502",
    );
  });

  it("falls back to status-only on non-JSON body", () => {
    expect(formatProviderError("Ollama", 500, "<html>Internal Server Error</html>")).toBe(
      "Ollama API error 500",
    );
  });

  it("does NOT include the free-form error.message even if it would have been long", () => {
    // Regression: error.message historically echoed prompt fragments
    // (\"You requested ... <full prompt content> ... which is invalid\").
    // The sanitizer must drop it from the public string.
    const promptEcho =
      "Bad request: you sent prompt='SECRET internal data exfiltrated via prompt injection'";
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: promptEcho },
    });
    const formatted = formatProviderError("Anthropic", 400, body);
    expect(formatted).toBe("Anthropic API error 400 (invalid_request_error)");
    expect(formatted).not.toContain("SECRET");
    expect(formatted).not.toContain("prompt");
  });

  it("ignores non-string type/code values", () => {
    const body = JSON.stringify({ error: { type: 42, code: { nested: true } } });
    expect(formatProviderError("Anthropic", 400, body)).toBe("Anthropic API error 400");
  });

  it("handles empty body", () => {
    expect(formatProviderError("Anthropic", 504, "")).toBe("Anthropic API error 504");
  });

  it("caps extracted type/code at 64 chars (defends against prompt-stuffed fields)", () => {
    // An upstream that misbehaves and dumps prompt content into the type
    // field should still be bounded.
    const longType = "x".repeat(200) + "_SECRET_PROMPT_FRAGMENT";
    const body = JSON.stringify({ error: { type: longType } });
    const formatted = formatProviderError("Anthropic", 400, body);
    expect(formatted).toBe(`Anthropic API error 400 (${"x".repeat(64)})`);
    expect(formatted).not.toContain("SECRET");
  });
});
