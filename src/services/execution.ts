import { findById } from "../repositories/agent-registry.js";
import * as execRepo from "../repositories/execution-log.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { LocalProvider } from "../providers/local.js";
import type {
  AgentProvider,
  AgentRequest,
  ExecutionRecord,
} from "../types/execution.js";
import { uuidv7 } from "../types/task.js";

function getProvider(provider: string, modelId: string): AgentProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(modelId);
    case "openai":
      return new OpenAIProvider(modelId);
    case "local":
      return new LocalProvider(modelId);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function execute(
  agentId: string,
  request: AgentRequest,
  maxRetries: number = 2,
): Promise<ExecutionRecord> {
  const agent = await findById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const provider = getProvider(agent.provider, agent.model_id);
  let lastRecord: ExecutionRecord | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const executionId = uuidv7();
    const start = Date.now();

    try {
      const response = await provider.invoke(request);
      const latencyMs = Date.now() - start;
      const costUsd =
        (response.input_tokens / 1000) * agent.cost_per_1k_input +
        (response.output_tokens / 1000) * agent.cost_per_1k_output;

      const record: ExecutionRecord = {
        execution_id: executionId,
        task_id: request.task_id,
        agent_id: agentId,
        attempt_number: attempt,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        ttft_ms: response.ttft_ms,
        outcome: "SUCCESS",
        error_detail: null,
        response_content: response.content,
      };

      await execRepo.insertExecution(record);
      return record;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = (err as Error).message === "TIMEOUT";
      const isLastAttempt = attempt === maxRetries + 1;

      const record: ExecutionRecord = {
        execution_id: executionId,
        task_id: request.task_id,
        agent_id: agentId,
        attempt_number: attempt,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        latency_ms: latencyMs,
        ttft_ms: 0,
        outcome: isLastAttempt ? (isTimeout ? "TIMEOUT" : "ERROR") : "FALLBACK",
        error_detail: (err as Error).message,
        response_content: null,
      };

      await execRepo.insertExecution(record);
      lastRecord = record;

      if (isLastAttempt) return record;

      // Exponential backoff: 1s, 2s, 4s...
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
      );
    }
  }

  return lastRecord!;
}
