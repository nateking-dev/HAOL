import { z } from "zod";
import { FormatSpec } from "./outcome.js";

export const TaskStatus = z.enum(["RECEIVED", "CLASSIFIED", "DISPATCHED", "COMPLETED", "FAILED"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const RouterTaskInput = z.object({
  prompt: z.string().min(1).max(100_000),
  metadata: z
    .object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      capabilities: z.array(z.string()).optional(),
    })
    .optional(),
  constraints: z
    .object({
      max_tokens: z.number().optional(),
      timeout_ms: z.number().optional(),
      temperature: z.number().optional(),
    })
    .optional(),
  expected_format: FormatSpec.optional(),
});
export type RouterTaskInput = z.infer<typeof RouterTaskInput>;

export const TaskResult = z.object({
  task_id: z.string(),
  status: TaskStatus,
  complexity_tier: z.number().nullable(),
  selected_agent_id: z.string().nullable(),
  response_content: z.string().nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
});
export type TaskResult = z.infer<typeof TaskResult>;
