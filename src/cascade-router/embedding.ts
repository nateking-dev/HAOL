import type { EmbeddingProvider, RouterConfig } from "./types.js";
import { OpenAIEmbeddingProvider } from "./embedding-openai.js";

export function createEmbeddingProvider(
  config: RouterConfig,
): EmbeddingProvider {
  return new OpenAIEmbeddingProvider({
    modelId: config.embedding_model,
    dimensions: config.embedding_dimensions,
  });
}
