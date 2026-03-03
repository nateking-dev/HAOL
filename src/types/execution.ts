import { z } from "zod";

export interface AgentRequest {
  task_id: string;
  prompt: string;
  system_prompt?: string;
  context: Record<string, unknown>;
  constraints: {
    max_tokens: number;
    timeout_ms: number;
    temperature?: number;
  };
}

export interface AgentResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  ttft_ms: number;
  total_ms: number;
  metadata: Record<string, unknown>;
}

export interface HealthStatus {
  healthy: boolean;
  latency_ms: number;
}

export interface AgentProvider {
  invoke(request: AgentRequest): Promise<AgentResponse>;
  healthCheck(): Promise<HealthStatus>;
  estimateTokens(prompt: string): number;
}

export const ExecutionOutcome = z.enum(["SUCCESS", "TIMEOUT", "ERROR", "FALLBACK"]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcome>;

export const ExecutionRecord = z.object({
  execution_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  attempt_number: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  latency_ms: z.number(),
  ttft_ms: z.number(),
  outcome: ExecutionOutcome,
  error_detail: z.string().nullable(),
  response_content: z.string().nullable(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;
