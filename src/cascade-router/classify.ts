import type { TaskInput, TaskClassification } from "../types/task.js";
import { CascadeRouter } from "./cascade-router.js";
import { createEmbeddingProvider } from "./embedding.js";
import { AnthropicEscalationProvider } from "./escalation.js";
import * as store from "./reference-store.js";

let instancePromise: Promise<CascadeRouter> | null = null;

async function initCascadeRouter(): Promise<CascadeRouter> {
  // Check if cascade tables have data — if not, fall back to old classifier
  const rules = await store.loadRules();
  const hasEmbed = await store.hasEmbeddings();
  if (rules.length === 0 && !hasEmbed) {
    throw new Error(
      "Cascade router not seeded — falling back to old classifier",
    );
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

  return CascadeRouter.create({
    embeddingProvider,
    escalationProvider,
  });
}

async function getInstance(): Promise<CascadeRouter> {
  if (!instancePromise) {
    instancePromise = initCascadeRouter().catch((err) => {
      instancePromise = null;
      throw err;
    });
  }
  return instancePromise;
}

export async function classifyCascade(
  input: TaskInput,
): Promise<TaskClassification> {
  const router = await getInstance();
  return router.classify(input);
}

/** Reset the singleton (for testing) */
export function resetCascadeRouter(): void {
  instancePromise = null;
}
