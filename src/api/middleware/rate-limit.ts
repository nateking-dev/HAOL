import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

interface RateLimitOptions {
  /** Maximum requests allowed within the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /**
   * Whether to trust the X-Forwarded-For header for client IP identification.
   * Only enable this when running behind a trusted reverse proxy.
   * Default: false (uses socket remote address for per-IP limiting).
   */
  trustProxy?: boolean;
  /**
   * Use a single shared bucket for all clients instead of per-IP.
   * Useful for endpoints that should have a process-wide limit
   * (e.g., expensive operations protected by an advisory lock).
   * Default: false.
   */
  global?: boolean;
}

/**
 * Simple in-memory sliding-window rate limiter (token bucket variant).
 *
 * Each unique client IP gets a bucket that refills at a constant rate.
 * When the bucket is empty the request is rejected with 429.
 *
 * NOT suitable for multi-process / clustered deployments — use Redis or
 * similar in that case. Fine for a single-process Hono server.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, trustProxy = false, global: globalBucket = false } = opts;
  const buckets = new Map<string, BucketEntry>();

  // Refill rate: tokens per millisecond
  const refillRate = limit / windowMs;

  // Periodically prune stale buckets to avoid unbounded memory growth.
  const PRUNE_INTERVAL_MS = 60_000;
  let lastPrune = Date.now();

  function prune(now: number): void {
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    for (const [key, entry] of buckets) {
      // If enough time has passed that the bucket would be full, remove it
      const elapsed = now - entry.lastRefill;
      if (elapsed > windowMs * 2) {
        buckets.delete(key);
      }
    }
  }

  return async (c, next) => {
    const now = Date.now();
    prune(now);

    // Identify the bucket key.
    // global: all clients share one bucket (for process-wide limits).
    // trustProxy: read X-Forwarded-For from a trusted reverse proxy.
    // default: use the socket remote address via @hono/node-server.
    // Note: getConnInfo requires @hono/node-server; other adapters will
    // fall back to the shared "unknown" bucket.
    let key = "global";
    if (!globalBucket) {
      if (trustProxy) {
        key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      } else {
        try {
          const info = getConnInfo(c);
          key = info.remote.address ?? "unknown";
        } catch {
          // getConnInfo fails without a real socket (tests, non-Node adapters).
          console.warn("[rate-limit] Could not resolve client IP — using shared bucket");
        }
      }
    }

    let entry = buckets.get(key);
    if (!entry) {
      entry = { tokens: limit, lastRefill: now };
      buckets.set(key, entry);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill;
    entry.tokens = Math.min(limit, entry.tokens + elapsed * refillRate);
    entry.lastRefill = now;

    if (entry.tokens < 1) {
      const retryAfter = Math.ceil((1 - entry.tokens) / refillRate / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests" }, 429);
    }

    entry.tokens -= 1;

    // Expose standard rate-limit headers
    const resetMs = (limit - entry.tokens) / refillRate;
    const resetEpoch = Math.ceil((now + resetMs) / 1000);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.floor(entry.tokens)));
    c.header("X-RateLimit-Reset", String(resetEpoch));

    await next();
  };
}
