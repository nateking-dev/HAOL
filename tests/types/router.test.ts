import { describe, it, expect } from "vitest";
import { RouterTaskInput } from "../../src/types/router.js";

describe("RouterTaskInput constraints", () => {
  it("accepts bounded execution constraints", () => {
    const result = RouterTaskInput.safeParse({
      prompt: "summarize this",
      constraints: {
        max_tokens: 1024,
        timeout_ms: 15_000,
        temperature: 0.5,
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unbounded token, timeout, and temperature values", () => {
    expect(
      RouterTaskInput.safeParse({
        prompt: "summarize this",
        constraints: { max_tokens: 100_000 },
      }).success,
    ).toBe(false);

    expect(
      RouterTaskInput.safeParse({
        prompt: "summarize this",
        constraints: { timeout_ms: 600_000 },
      }).success,
    ).toBe(false);

    expect(
      RouterTaskInput.safeParse({
        prompt: "summarize this",
        constraints: { temperature: 99 },
      }).success,
    ).toBe(false);
  });
});
