import type { TaskInput, TaskClassification } from "../types/task.js";
import { CascadeRouter } from "./cascade-router.js";
import { createEmbeddingProvider } from "./embedding.js";
import { AnthropicEscalationProvider } from "./escalation.js";
import * as store from "./reference-store.js";

let instance: CascadeRouter | null = null;

async function getInstance(): Promise<CascadeRouter> {
  if (!instance) {
    // Check if cascade tables have data — if not, fall back to old classifier
    const rules = await store.loadRules();
    const hasEmbed = await store.hasEmbeddings();
    if (rules.length === 0 && !hasEmbed) {
      throw new Error("Cascade router not seeded — falling back to old classifier");
    }

    const config = await store.loadConfig();

    let embeddingProvider;
    try {
      embeddingProvider = createEmbeddingProvider(config);
    } catch {
      // No OpenAI key — semantic layer unavailable
    }

    let escalationProvider;
    try {
      if (process.env.ANTHROPIC_API_KEY) {
        escalationProvider = new AnthropicEscalationProvider({
          modelId: config.escalation_model,
        });
      }
    } catch {
      // No Anthropic key — escalation layer unavailable
    }

    instance = await CascadeRouter.create({
      embeddingProvider,
      escalationProvider,
    });
  }
  return instance;
}

export async function classifyCascade(input: TaskInput): Promise<TaskClassification> {
  const router = await getInstance();
  return router.classify(input);
}

/** Reset the singleton (for testing) */
export function resetCascadeRouter(): void {
  instance = null;
}
