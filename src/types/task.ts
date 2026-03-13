import { z } from "zod";
import { createHash } from "node:crypto";

// --- UUIDv7 generation ---

export function uuidv7(): string {
  const uuid = crypto.randomUUID();
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return (
    timestamp.slice(0, 8) + "-" + timestamp.slice(8, 12) + "-7" + uuid.slice(15)
  );
}

// --- SHA-256 hashing ---

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// --- Zod schemas ---

export const ComplexityTier = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ComplexityTier = z.infer<typeof ComplexityTier>;

export const TaskInput = z.object({
  prompt: z.string(),
  metadata: z
    .object({
      tier: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
        .optional(),
      capabilities: z.array(z.string()).optional(),
    })
    .optional(),
});
export type TaskInput = z.infer<typeof TaskInput>;

export const TaskClassification = z.object({
  task_id: z.string(),
  complexity_tier: ComplexityTier,
  required_capabilities: z.array(z.string()),
  cost_ceiling_usd: z.number(),
  prompt_hash: z.string(),
  routing_confidence: z.number().optional(),
  routing_layer: z.string().optional(),
});
export type TaskClassification = z.infer<typeof TaskClassification>;
