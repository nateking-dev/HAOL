import type { EmbeddingProvider } from "./types.js";

export interface OpenAIEmbeddingOpts {
  apiKey?: string;
  modelId?: string;
  dimensions?: number | null;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private dims: number;
  private requestDims: number | null;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: OpenAIEmbeddingOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key required. Pass apiKey or set OPENAI_API_KEY.",
      );
    }

    this.model = opts.modelId ?? "text-embedding-3-small";
    this.requestDims = opts.dimensions === undefined ? 512 : opts.dimensions;
    this.dims = this.requestDims ?? this.nativeDimensions();
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async embed(text: string): Promise<number[]> {
    const body: Record<string, unknown> = {
      input: text,
      model: this.model,
      encoding_format: "float",
    };

    if (this.requestDims !== null) {
      body.dimensions = this.requestDims;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI embedding request failed (${response.status}): ${errorBody}`,
        );
      }

      const result = (await response.json()) as {
        data?: { embedding: number[] }[];
      };
      const embedding = result.data?.[0]?.embedding;

      if (!Array.isArray(embedding)) {
        throw new Error(
          `Unexpected response shape: ${JSON.stringify(result).slice(0, 200)}`,
        );
      }

      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > 2048) {
      throw new Error(
        `Batch size ${texts.length} exceeds OpenAI limit of 2048`,
      );
    }

    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
      encoding_format: "float",
    };

    if (this.requestDims !== null) {
      body.dimensions = this.requestDims;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI batch embedding failed (${response.status}): ${errorBody}`,
        );
      }

      const result = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };

      const sorted = result.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }

  modelId(): string {
    return this.model;
  }

  dimensions(): number {
    return this.dims;
  }

  private nativeDimensions(): number {
    switch (this.model) {
      case "text-embedding-3-small":
        return 1536;
      case "text-embedding-3-large":
        return 3072;
      case "text-embedding-ada-002":
        return 1536;
      default:
        return 1536;
    }
  }
}
