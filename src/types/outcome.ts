import { z } from "zod";

export const OutcomeTier = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type OutcomeTier = z.infer<typeof OutcomeTier>;

export const OutcomeSource = z.enum([
  "pipeline",
  "format_check",
  "routing_eval",
  "downstream",
]);
export type OutcomeSource = z.infer<typeof OutcomeSource>;

export const FormatSpec = z.object({
  type: z.string().optional(),
  max_length: z.number().optional(),
  min_length: z.number().optional(),
  required_fields: z.array(z.string()).optional(),
});
export type FormatSpec = z.infer<typeof FormatSpec>;

export const TaskOutcomeRecord = z.object({
  outcome_id: z.string(),
  task_id: z.string(),
  tier: OutcomeTier,
  source: OutcomeSource,
  signal_type: z.string(),
  signal_value: z.union([z.literal(0), z.literal(1)]).nullable(),
  confidence: z.number().nullable().default(null),
  detail: z.record(z.string(), z.unknown()).nullable().default(null),
  reported_by: z.string().nullable().default(null),
  created_at: z.string().optional(),
});
export type TaskOutcomeRecord = z.infer<typeof TaskOutcomeRecord>;

export const DownstreamOutcomeInput = z.object({
  signal_type: z.string().min(1),
  signal_value: z.union([z.literal(0), z.literal(1)]),
  reported_by: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type DownstreamOutcomeInput = z.infer<typeof DownstreamOutcomeInput>;

export const OutcomeSummary = z.object({
  task_id: z.string(),
  total_signals: z.number(),
  positive_signals: z.number(),
  negative_signals: z.number(),
  by_tier: z.record(
    z.string(),
    z.object({
      total: z.number(),
      positive: z.number(),
      negative: z.number(),
      signals: z.array(
        z.object({
          signal_type: z.string(),
          signal_value: z.number().nullable(),
          confidence: z.number().nullable(),
        }),
      ),
    }),
  ),
});
export type OutcomeSummary = z.infer<typeof OutcomeSummary>;
