import { z } from "zod";

export const AgentStatus = z.enum(["active", "degraded", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentProvider = z.enum(["anthropic", "openai", "local"]);
export type AgentProvider = z.infer<typeof AgentProvider>;

export const AgentRegistration = z.object({
  agent_id: z.string(),
  provider: z.string(),
  model_id: z.string(),
  capabilities: z.array(z.string()),
  cost_per_1k_input: z.number().min(0),
  cost_per_1k_output: z.number().min(0),
  max_context_tokens: z.number().int().positive(),
  avg_latency_ms: z.number().int().min(0),
  status: AgentStatus,
  tier_ceiling: z.number().int().min(1).max(4),
});
export type AgentRegistration = z.infer<typeof AgentRegistration>;

export const CreateAgentInput = z.object({
  agent_id: z.string(),
  provider: AgentProvider,
  model_id: z.string(),
  capabilities: z.array(z.string()),
  cost_per_1k_input: z.number().min(0),
  cost_per_1k_output: z.number().min(0),
  max_context_tokens: z.number().int().positive(),
  avg_latency_ms: z.number().int().min(0).default(0),
  status: AgentStatus.default("active"),
  tier_ceiling: z.number().int().min(1).max(4),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  provider: AgentProvider.optional(),
  model_id: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  cost_per_1k_input: z.number().min(0).optional(),
  cost_per_1k_output: z.number().min(0).optional(),
  max_context_tokens: z.number().int().positive().optional(),
  avg_latency_ms: z.number().int().min(0).optional(),
  status: AgentStatus.optional(),
  tier_ceiling: z.number().int().min(1).max(4).optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;
