import type {
  AgentProvider,
  AgentRequest,
  AgentResponse,
  HealthStatus,
} from "../types/execution.js";

export class AnthropicProvider implements AgentProvider {
  private apiKey: string;
  private modelId: string;

  constructor(modelId: string) {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
    this.modelId = modelId;
  }

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.constraints.timeout_ms,
    );
    const start = Date.now();

    try {
      const body = {
        model: this.modelId,
        max_tokens: request.constraints.max_tokens,
        messages: [{ role: "user" as const, content: request.prompt }],
        ...(request.system_prompt && { system: request.system_prompt }),
        ...(request.constraints.temperature !== undefined && {
          temperature: request.constraints.temperature,
        }),
      };

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const ttft = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        content?: { text: string }[];
        usage?: { input_tokens: number; output_tokens: number };
        model?: string;
        stop_reason?: string;
      };
      const totalMs = Date.now() - start;

      return {
        content: data.content?.[0]?.text || "",
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
        ttft_ms: ttft,
        total_ms: totalMs,
        metadata: { model: data.model, stop_reason: data.stop_reason },
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("TIMEOUT");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      return { healthy: response.ok, latency_ms: Date.now() - start };
    } catch {
      return { healthy: false, latency_ms: Date.now() - start };
    }
  }

  estimateTokens(prompt: string): number {
    return Math.ceil(prompt.length / 4);
  }
}
