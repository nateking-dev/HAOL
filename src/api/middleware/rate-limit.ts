import type { MiddlewareHandler } from "hono";

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
   * Default: false (all clients share a single "unknown" bucket).
   */
  trustProxy?: boolean;
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
  const { limit, windowMs, trustProxy = false } = opts;
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

    // Only read X-Forwarded-For when explicitly trusted (i.e. behind a
    // known reverse proxy). Otherwise attackers can spoof arbitrary IPs
    // to bypass rate limiting.
    const ip = trustProxy
      ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown")
      : "unknown";

    let entry = buckets.get(ip);
    if (!entry) {
      entry = { tokens: limit, lastRefill: now };
      buckets.set(ip, entry);
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
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.floor(entry.tokens)));

    await next();
  };
}
