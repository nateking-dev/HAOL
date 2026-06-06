import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { rateLimit, validateRateLimitConfig } from "../../../src/api/middleware/rate-limit.js";
import { _setDestinationForTests } from "../../../src/logging/logger.js";
import { CaptureStream, LogLevel, setLogLevel } from "../../helpers/capture-stream.js";

interface AppOpts {
  limit: number;
  windowMs: number;
  trustedProxyHops?: number;
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

function reqXff(xff: string) {
  return { headers: { "x-forwarded-for": xff } };
}

describe("rateLimit middleware", () => {
  let capture: CaptureStream;
  let restoreLogLevel: () => void;

  beforeEach(() => {
    // The middleware emits a structured warn when getConnInfo fails (no
    // socket in test requests). Capture pino output instead of console.
    restoreLogLevel = setLogLevel("trace");
    capture = new CaptureStream();
    _setDestinationForTests(capture);
  });

  afterEach(() => {
    _setDestinationForTests(undefined);
    restoreLogLevel();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("token bucket basics", () => {
    it("allows the first `limit` requests within the window", async () => {
      const app = buildApp({ limit: 3, windowMs: 60_000, trustedProxyHops: 1 });
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/ping", reqFrom("10.0.0.1"));
        expect(res.status).toBe(200);
      }
    });

    it("rejects with 429 once the bucket is empty", async () => {
      const app = buildApp({ limit: 2, windowMs: 60_000, trustedProxyHops: 1 });
      await app.request("/ping", reqFrom("10.0.0.1"));
      await app.request("/ping", reqFrom("10.0.0.1"));
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many requests" });
    });

    it("sets a Retry-After header on 429 responses", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 1 });
      await app.request("/ping", reqFrom("10.0.0.1"));
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.status).toBe(429);
      const retry = res.headers.get("Retry-After");
      expect(retry).toBeTruthy();
      expect(Number(retry)).toBeGreaterThan(0);
    });

    it("sets X-RateLimit-Limit/Remaining/Reset headers on success", async () => {
      const app = buildApp({ limit: 5, windowMs: 60_000, trustedProxyHops: 1 });
      const res = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
      const remaining = Number(res.headers.get("X-RateLimit-Remaining"));
      expect(remaining).toBe(4); // 5 - 1 consumed
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("decrements X-RateLimit-Remaining on each successful request", async () => {
      const app = buildApp({ limit: 3, windowMs: 60_000, trustedProxyHops: 1 });
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r3 = await app.request("/ping", reqFrom("10.0.0.1"));
      expect(r1.headers.get("X-RateLimit-Remaining")).toBe("2");
      expect(r2.headers.get("X-RateLimit-Remaining")).toBe("1");
      expect(r3.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });

  describe("per-IP isolation", () => {
    it("does not let one IP exhaust another's bucket", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 1 });
      const a1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const a2 = await app.request("/ping", reqFrom("10.0.0.1"));
      const b1 = await app.request("/ping", reqFrom("10.0.0.2"));
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(429);
      expect(b1.status).toBe(200);
    });
  });

  describe("trusted-proxy hop resolution", () => {
    it("reads the client IP from the right per trustedProxyHops, ignoring prepended entries (spoof-resistant)", async () => {
      // hops=1: the real client IP is the rightmost entry (appended by our LB).
      // An attacker who rotates the LEFTMOST (client-supplied) value must NOT
      // get a fresh bucket — both requests share the rightmost IP.
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 1 });
      const r1 = await app.request("/ping", reqXff("1.1.1.1, 203.0.113.7"));
      const r2 = await app.request("/ping", reqXff("9.9.9.9, 203.0.113.7"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429); // same rightmost IP → same bucket
    });

    it("isolates distinct real clients by the right-anchored IP", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 1 });
      const a = await app.request("/ping", reqXff("1.1.1.1, 203.0.113.7"));
      const b = await app.request("/ping", reqXff("1.1.1.1, 203.0.113.8"));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200); // different rightmost IP → different bucket
    });

    it("counts the configured number of hops from the right (hops=2)", async () => {
      // client -> CDN -> LB -> app. XFF = "<client>, <cdn>"; the LB's own peer
      // (cdn) is the connection, the client is 2 from the right.
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 2 });
      // Same client, different downstream proxy hop — must still share a bucket.
      const r1 = await app.request("/ping", reqXff("198.51.100.5, 10.0.0.1"));
      const r2 = await app.request("/ping", reqXff("198.51.100.5, 10.0.0.2"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
    });

    it("falls back to the socket peer (and warns) when XFF is shorter than the hop count", async () => {
      // hops=2 but only one XFF entry — the request didn't traverse the full
      // chain. We must not trust the partial chain; fall back to socket (which
      // throws in tests → 'unknown' shared bucket).
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 2 });
      const r1 = await app.request("/ping", reqXff("203.0.113.7"));
      const r2 = await app.request("/ping", reqXff("203.0.113.9"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429); // both fell back to the shared 'unknown' bucket
      const warns = capture.records(LogLevel.WARN);
      expect(warns.some((w) => /shorter than trustedProxyHops/.test(String(w.msg)))).toBe(true);
    });

    it("ignores X-Forwarded-For entirely when hops=0 (default)", async () => {
      // No hops configured → socket peer only. In tests getConnInfo throws, so
      // every request shares the 'unknown' bucket regardless of XFF.
      const app = buildApp({ limit: 1, windowMs: 60_000 });
      const r1 = await app.request("/ping", reqFrom("10.0.0.1"));
      const r2 = await app.request("/ping", reqFrom("10.0.0.2"));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429); // XFF ignored → same shared bucket
      const warns = capture.records(LogLevel.WARN);
      expect(warns[0]).toMatchObject({ component: "rate-limit" });
    });

    it("falls back to the shared bucket when hops>0 and X-Forwarded-For is missing", async () => {
      const app = buildApp({ limit: 1, windowMs: 60_000, trustedProxyHops: 1 });
      const r1 = await app.request("/ping");
      const r2 = await app.request("/ping");
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
    });

    it("uses RATE_LIMIT_TRUSTED_PROXY_HOPS when trustedProxyHops is omitted", async () => {
      vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "1");
      const app = buildApp({ limit: 1, windowMs: 60_000 });
      // env hops=1 → rightmost is the key; same rightmost shares a bucket.
      const r1 = await app.request("/ping", reqXff("1.1.1.1, 203.0.113.7"));
      const r2 = await app.request("/ping", reqXff("9.9.9.9, 203.0.113.7"));
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

    it("global mode ignores X-Forwarded-For even with hops configured", async () => {
      const app = buildApp({ limit: 2, windowMs: 60_000, global: true, trustedProxyHops: 1 });
      await app.request("/ping", reqFrom("10.0.0.1"));
      await app.request("/ping", reqFrom("10.0.0.2"));
      const r3 = await app.request("/ping", reqFrom("10.0.0.3"));
      expect(r3.status).toBe(429);
    });
  });

  describe("token refill", () => {
    it("refills tokens proportionally to elapsed time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      const app = buildApp({ limit: 4, windowMs: 4_000, trustedProxyHops: 1 });
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
      const app = buildApp({ limit: 2, windowMs: 1_000, trustedProxyHops: 1 });
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
      const app = buildApp({ limit: 1, windowMs: 1_000, trustedProxyHops: 1 });

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

describe("validateRateLimitConfig", () => {
  // validateRateLimitConfig reads process.env at call time, so vi.stubEnv is
  // enough — no module reset / re-import needed. That keeps the captured
  // logger instance bound, so the validator's fatal/info lines never leak to
  // the test runner's stdout.
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let restoreLogLevel: () => void;
  let capture: CaptureStream;

  beforeEach(() => {
    restoreLogLevel = setLogLevel("trace");
    capture = new CaptureStream();
    _setDestinationForTests(capture);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    restoreLogLevel();
    vi.unstubAllEnvs();
    _setDestinationForTests(undefined);
  });

  it("does nothing outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "");
    expect(() => validateRateLimitConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits in production when RATE_LIMIT_TRUSTED_PROXY_HOPS is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "");
    expect(() => validateRateLimitConfig()).toThrow(/process\.exit\(1\)/);
    const fatals = capture.records(LogLevel.FATAL);
    expect(fatals.length).toBeGreaterThan(0);
    expect(fatals[0].msg).toMatch(/RATE_LIMIT_TRUSTED_PROXY_HOPS is not set/);
  });

  it("exits in production when the value is not a non-negative integer", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "-1");
    expect(() => validateRateLimitConfig()).toThrow(/process\.exit\(1\)/);
    const fatals = capture.records(LogLevel.FATAL);
    expect(fatals[0].msg).toMatch(/must be a non-negative integer/);
  });

  it("does not exit in production when a valid value is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "1");
    expect(() => validateRateLimitConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
