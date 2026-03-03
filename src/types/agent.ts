import { z } from "zod";

export const AgentStatus = z.enum(["active", "degraded", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentRegistration = z.object({
  agent_id: z.string(),
  provider: z.string(),
  model_id: z.string(),
  capabilities: z.array(z.string()),
  cost_per_1k_input: z.number(),
  cost_per_1k_output: z.number(),
  max_context_tokens: z.number(),
  avg_latency_ms: z.number(),
  status: AgentStatus,
  tier_ceiling: z.number(),
});
export type AgentRegistration = z.infer<typeof AgentRegistration>;

export const CreateAgentInput = z.object({
  agent_id: z.string(),
  provider: z.string(),
  model_id: z.string(),
  capabilities: z.array(z.string()),
  cost_per_1k_input: z.number(),
  cost_per_1k_output: z.number(),
  max_context_tokens: z.number(),
  avg_latency_ms: z.number().default(0),
  status: AgentStatus.default("active"),
  tier_ceiling: z.number(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const UpdateAgentInput = z.object({
  provider: z.string().optional(),
  model_id: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  cost_per_1k_input: z.number().optional(),
  cost_per_1k_output: z.number().optional(),
  max_context_tokens: z.number().optional(),
  avg_latency_ms: z.number().optional(),
  status: AgentStatus.optional(),
  tier_ceiling: z.number().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;
