import type {
  AgentProvider,
  AgentRequest,
  AgentResponse,
  HealthStatus,
} from "../types/execution.js";

export class OpenAIProvider implements AgentProvider {
  private apiKey: string;
  private modelId: string;

  constructor(modelId: string) {
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.modelId = modelId;
  }

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.constraints.timeout_ms);
    const start = Date.now();

    try {
      const messages: { role: string; content: string }[] = [];
      if (request.system_prompt) {
        messages.push({ role: "system", content: request.system_prompt });
      }
      messages.push({ role: "user", content: request.prompt });

      const body = {
        model: this.modelId,
        max_tokens: request.constraints.max_tokens,
        messages,
        ...(request.constraints.temperature !== undefined && {
          temperature: request.constraints.temperature,
        }),
      };

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const ttft = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        choices?: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
        model?: string;
      };
      const totalMs = Date.now() - start;

      return {
        content: data.choices?.[0]?.message?.content || "",
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
        ttft_ms: ttft,
        total_ms: totalMs,
        metadata: { model: data.model },
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
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
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
