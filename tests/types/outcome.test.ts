import { describe, it, expect } from "vitest";
import { DownstreamOutcomeInput } from "../../src/types/outcome.js";

const base = {
  signal_type: "accuracy",
  signal_value: 1 as const,
  reported_by: "test-suite",
};

describe("DownstreamOutcomeInput detail size limit", () => {
  it("accepts a payload well under the limit", () => {
    const result = DownstreamOutcomeInput.safeParse({
      ...base,
      detail: { note: "small" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a payload at exactly 4096 bytes", () => {
    // {"x":"..."} = 8 bytes of framing, so value needs 4088 bytes
    const value = "a".repeat(4088);
    const detail = { x: value };
    // Sanity check
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBe(4096);

    const result = DownstreamOutcomeInput.safeParse({ ...base, detail });
    expect(result.success).toBe(true);
  });

  it("rejects a payload at 4097 bytes", () => {
    const value = "a".repeat(4089);
    const detail = { x: value };
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBe(4097);

    const result = DownstreamOutcomeInput.safeParse({ ...base, detail });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toMatch(/4096 bytes/);
    }
  });

  it("rejects multibyte characters that push byte size over the limit", () => {
    // Each emoji is 4 bytes in UTF-8 but 2 UTF-16 code units
    // 1024 emojis × 4 bytes = 4096 bytes for values alone, plus JSON framing pushes it over
    const value = "\u{1F600}".repeat(1024);
    const detail = { x: value };
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeGreaterThan(4096);

    const result = DownstreamOutcomeInput.safeParse({ ...base, detail });
    expect(result.success).toBe(false);
  });

  it("accepts when detail is absent", () => {
    const result = DownstreamOutcomeInput.safeParse(base);
    expect(result.success).toBe(true);
  });
});
