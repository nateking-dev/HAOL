import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

describe("AnthropicProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("successful invocation returns correct shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Hello!" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      }),
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");
    const response = await provider.invoke({
      task_id: "test-123",
      prompt: "Hello",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000 },
    });

    expect(response.content).toBe("Hello!");
    expect(response.input_tokens).toBe(10);
    expect(response.output_tokens).toBe(5);
    expect(response.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(response.total_ms).toBeGreaterThanOrEqual(0);
    expect(response.metadata).toEqual({
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
    });

    // Verify the fetch was called with the right URL and headers
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("passes system_prompt and temperature when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "response" }],
        usage: { input_tokens: 5, output_tokens: 3 },
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      }),
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");
    await provider.invoke({
      task_id: "test-456",
      prompt: "Hello",
      system_prompt: "You are a helpful assistant.",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000, temperature: 0.5 },
    });

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.system).toBe("You are a helpful assistant.");
    expect(body.temperature).toBe(0.5);
  });

  it("timeout triggers AbortError and throws TIMEOUT", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Listen for the abort signal and reject like a real fetch would
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");

    await expect(
      provider.invoke({
        task_id: "test-timeout",
        prompt: "Hello",
        context: {},
        constraints: { max_tokens: 100, timeout_ms: 50 },
      }),
    ).rejects.toThrow("TIMEOUT");
  });

  it("API error (500) throws with status code", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");

    await expect(
      provider.invoke({
        task_id: "test-error",
        prompt: "Hello",
        context: {},
        constraints: { max_tokens: 100, timeout_ms: 5000 },
      }),
    ).rejects.toThrow("Anthropic API error 500");
  });

  it("estimateTokens returns roughly prompt.length / 4", () => {
    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");
    const estimate = provider.estimateTokens("Hello, world!"); // 13 chars
    expect(estimate).toBe(Math.ceil(13 / 4)); // 4
  });
});
