import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai.js";

describe("OpenAIProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("successful invocation returns correct shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from GPT!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        model: "gpt-4o",
      }),
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider("gpt-4o");
    const response = await provider.invoke({
      task_id: "test-openai-1",
      prompt: "Hello",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000 },
    });

    expect(response.content).toBe("Hello from GPT!");
    expect(response.input_tokens).toBe(12);
    expect(response.output_tokens).toBe(8);
    expect(response.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(response.total_ms).toBeGreaterThanOrEqual(0);
    expect(response.metadata).toEqual({ model: "gpt-4o" });

    // Verify the fetch was called with the right URL and Bearer auth
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
        }),
      }),
    );
  });

  it("passes system_prompt as a system message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "response" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        model: "gpt-4o",
      }),
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider("gpt-4o");
    await provider.invoke({
      task_id: "test-openai-sys",
      prompt: "Hello",
      system_prompt: "You are a helpful assistant.",
      context: {},
      constraints: { max_tokens: 100, timeout_ms: 5000, temperature: 0.7 },
    });

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(body.temperature).toBe(0.7);
  });

  it("timeout triggers AbortError and throws TIMEOUT", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const provider = new OpenAIProvider("gpt-4o");

    await expect(
      provider.invoke({
        task_id: "test-openai-timeout",
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

    const provider = new OpenAIProvider("gpt-4o");

    await expect(
      provider.invoke({
        task_id: "test-openai-error",
        prompt: "Hello",
        context: {},
        constraints: { max_tokens: 100, timeout_ms: 5000 },
      }),
    ).rejects.toThrow("OpenAI API error 500");
  });

  it("estimateTokens returns roughly prompt.length / 4", () => {
    const provider = new OpenAIProvider("gpt-4o");
    const estimate = provider.estimateTokens("Hello, world!"); // 13 chars
    expect(estimate).toBe(Math.ceil(13 / 4)); // 4
  });
});
