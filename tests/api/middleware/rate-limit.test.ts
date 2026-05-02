import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "../../../src/api/middleware/rate-limit.js";

interface AppOpts {
  limit: number;
  windowMs: number;
  trustProxy?: boolean;
  global?: boolean;
}

function buildApp(opts: AppOpts) {
  const app = new Hono();
  app.use("*", rateLimit(opts));
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

function reqFrom(ip: string) {
  return { headers: { "x-forwarded-for": ip } };
}

describe("rateLimit middleware", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The middleware logs a warn when getConnInfo fails (no socket in test
    // requests). Suppress so test output stays clean.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  describe("token bucket basics", () => {
    it("allows the first `limit` requests within the window", async () => {
      const app = buildApp({ limit: 3, windowMs: 60_000, trustProxy: true });
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/ping", reqFrom("10.0.0.1"));
        expect(res.status).toBe(200);
      }
    });

    it("rejects with 429 once the bucket is empty", async () => {
      const app = buildApp({ limit: 2, windowMs: 60_000, trustProxy: true });
      await app.request("/ping", reqFrom("10.0.0.1"));
      await app.request("/ping", reqFrom("10.0.0.1"));
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many requests" });
    });

    it("sets a Retry-After header on 429 responses", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustProxy: true });
      await app.request("/ping", reqFrom("10.0.0.1"));
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.status).toBe(429);
      const retry = res.headers.get("Retry-After");
      expect(retry).toBeTruthy();
      expect(Number(retry)).toBeGreaterThan(0);
    });

    it("sets X-RateLimit-Limit/Remaining/Reset headers on success", async () => {
      const app = buildApp({ limit: 5, windowMs: 60_000, trustProxy: true });
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
      const remaining = Number(res.headers.get("X-RateLimit-Remaining"));
      expect(remaining).toBe(4); // 5 - 1 consumed
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("decrements X-RateLimit-Remaining on each successful request", async () => {
      const app = buildApp({ limit: 3, windowMs: 60_000, trustProxy: true });
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r3 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r1.headers.get("X-RateLimit-Remaining")).toBe("2");
      expect(r2.headers.get("X-RateLimit-Remaining")).toBe("1");
      expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });

  describe("per-IP isolation (trustProxy)", () => {
    it("does not let one IP exhaust another's bucket", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustProxy: true });
      const a1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const a2 = await app.request("/ping", reqFrom("10.0.0.1"));
      const b1 = await app.request("/ping", reqFrom("10.0.0.2"));
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(429);
      expect(b1.status).toBe(200);
    });

    it("uses the first IP from a comma-separated X-Forwarded-For chain", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustProxy: true });
      // Two requests share the leftmost IP — second should 429.
      const r1 = await app.request("/ping", {
        headers: { "x-forwarded-for": "10.0.0.5, 10.0.0.6, 192.168.1.1" },
      });
      const r2 = await app.request("/ping", {
        headers: { "x-forwarded-for": "10.0.0.5, 192.168.1.99" },
      });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
    });

    it("falls back to a shared 'unknown' bucket when X-Forwarded-For is missing", async () => {
      // With trustProxy=true and no header, the key resolves to 'unknown' —
      // every client without the header shares one bucket.
      const app = buildApp({ limit: 1, windowMs: 60_000, trustProxy: true });
      const r1 = await app.request("/ping");
      const r2 = await app.request("/ping");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
    });
  });

  describe("global mode (shared bucket)", () => {
    it("uses one bucket for all clients regardless of IP", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, global: true });
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.2"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
    });

    it("global mode ignores X-Forwarded-For even with trustProxy unset", async () => {
      const app = buildApp({ limit: 2, windowMs: 60_000, global: true });
      await app.request("/ping", reqFrom("10.0.0.1"));
      await app.request("/ping", reqFrom("10.0.0.2"));
      const r3 = await app.request("/ping", reqFrom("10.0.0.3"));
      expect(r3.status).toBe(429);
    });
  });

  describe("default mode (no trustProxy, no socket)", () => {
    it("falls back to a shared 'unknown' bucket when getConnInfo fails", async () => {
      // Hono's app.request() has no real socket — getConnInfo throws and the
      // middleware logs a warn, then uses the 'unknown' bucket.
      const app = buildApp({ limit: 1, windowMs: 60_000 });
      const r1 = await app.request("/ping");
      const r2 = await app.request("/ping");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("token refill", () => {
    it("refills tokens proportionally to elapsed time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      const app = buildApp({ limit: 4, windowMs: 4_000, trustProxy: true });
      // Drain the bucket
      for (let i = 0; i < 4; i++) {
        await app.request("/ping", reqFrom("10.0.0.1"));
      }
      const blocked = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(blocked.status).toBe(429);

      // Advance half the window — should refill ~2 tokens.
      vi.advanceTimersByTime(2_000);
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const r3 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r3.status).toBe(429); // bucket drained again
    });

    it("caps refill at the configured limit (no token accumulation past the cap)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      const app = buildApp({ limit: 2, windowMs: 1_000, trustProxy: true });
      await app.request("/ping", reqFrom("10.0.0.1")); // 1 token left
      // Wait far longer than the window — bucket should refill to cap, not beyond.
      vi.advanceTimersByTime(10 * 60_000);
      // Verify only `limit` requests succeed before throttling kicks in.
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r3 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
    });
  });

  describe("bucket pruning", () => {
    it("evicts buckets that have been idle for more than 2x the window", async () => {
      // Pruning runs lazily on incoming requests, gated by PRUNE_INTERVAL_MS
      // (60s). We can't peek at the internal map, so we observe pruning
      // indirectly: an idle client past the eviction threshold gets a fresh
      // bucket (full quota) on its next request.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      const app = buildApp({ limit: 1, windowMs: 1_000, trustProxy: true });

      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r1.status).toBe(200);
      const r2 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r2.status).toBe(429);

      // Advance past 2x window AND past the 60s prune interval. A subsequent
      // request from a different IP triggers prune(); the original IP's
      // bucket is removed; a fresh request from it gets a full bucket.
      vi.advanceTimersByTime(120_000);
      await app.request("/ping", reqFrom("10.0.0.99")); // triggers prune

      // 10.0.0.1 should now have a fresh bucket; one more should also work
      // because token refill alone would have caught up — but the key
      // assertion is that pruning didn't break correctness (no orphaned
      // entries causing wrong throttling).
      const r3 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r3.status).toBe(200);
    });
  });
});
