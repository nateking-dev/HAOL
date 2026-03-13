import { z } from "zod";
import type { EscalationProvider, TierDefinition, TierId } from "./types.js";

const EscalationResponse = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  capabilities: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export class AnthropicEscalationProvider implements EscalationProvider {
  private apiKey: string;
  private modelId: string;
  private timeoutMs: number;

  constructor(
    opts: { apiKey?: string; modelId?: string; timeoutMs?: number } = {},
  ) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.modelId = opts.modelId ?? "claude-haiku-4-5-20251001";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async classify(
    prompt: string,
    tiers: TierDefinition[],
  ): Promise<{ tier: TierId; capabilities: string[]; confidence: number }> {
    const tierDescriptions = tiers
      .map(
        (t) =>
          `Tier ${t.tier_id} (${t.tier_name}): ${t.description ?? "No description"}`,
      )
      .join("\n");

    const systemPrompt = `You are a task complexity classifier. Given a user prompt, determine which complexity tier it belongs to and what capabilities are needed.

Tiers:
${tierDescriptions}

Respond with ONLY a JSON object (no markdown, no explanation):
{"tier": <number 1-4>, "capabilities": [<string array>], "confidence": <0.0-1.0>}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.modelId,
          max_tokens: 256,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error ${response.status}`);
      }

      const data = (await response.json()) as {
        content?: { text: string }[];
      };
      const text = data.content?.[0]?.text ?? "";

      const parsed = EscalationResponse.parse(JSON.parse(text));
      return {
        tier: parsed.tier as TierId,
        capabilities: parsed.capabilities,
        confidence: parsed.confidence,
      };
    } catch {
      // Conservative fallback on any failure
      return { tier: 3 as TierId, capabilities: [], confidence: 0.5 };
    } finally {
      clearTimeout(timeout);
    }
  }
}
