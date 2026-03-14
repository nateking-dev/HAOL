import type {
  AgentProvider,
  AgentRequest,
  AgentResponse,
  HealthStatus,
} from "../types/execution.js";

export class LocalProvider implements AgentProvider {
  private modelId: string;
  private baseUrl: string;

  constructor(modelId: string) {
    this.modelId = modelId;
    this.baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  }

  async invoke(request: AgentRequest): Promise<AgentResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.constraints.timeout_ms);
    const start = Date.now();

    try {
      const prompt = request.system_prompt
        ? `${request.system_prompt}\n\n${request.prompt}`
        : request.prompt;

      const body = {
        model: this.modelId,
        prompt,
        stream: false,
        options: {
          num_predict: request.constraints.max_tokens,
          ...(request.constraints.temperature !== undefined && {
            temperature: request.constraints.temperature,
          }),
        },
      };

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const ttft = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        response?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        model?: string;
      };
      const totalMs = Date.now() - start;

      return {
        content: data.response || "",
        input_tokens: data.prompt_eval_count || 0,
        output_tokens: data.eval_count || 0,
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
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
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
