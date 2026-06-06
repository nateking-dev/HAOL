import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { logger } from "../../logging/logger.js";

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
   * Number of trusted reverse-proxy hops in front of this server. The client
   * IP used for per-IP limiting is read from `X-Forwarded-For` by counting
   * this many entries from the RIGHT — the rightmost entry is the one appended
   * by the proxy nearest this server, which a client cannot forge. Counting
   * from the right means any extra addresses a client prepends are ignored, so
   * an attacker can't rotate the leftmost value to escape their bucket.
   *
   *   0 → ignore `X-Forwarded-For` entirely; use the socket peer address.
   *   1 → client → [trusted proxy] → app   (rightmost XFF entry)
   *   2 → client → [CDN] → [LB] → app      (2nd-from-right XFF entry)
   *
   * When omitted, falls back to the RATE_LIMIT_TRUSTED_PROXY_HOPS env var
   * (default 0). Ignored when `global` is set.
   */
  trustedProxyHops?: number;
  /**
   * Use a single shared bucket for all clients instead of per-IP.
   * Useful for endpoints that should have a process-wide limit
   * (e.g., expensive operations protected by an advisory lock).
   * Default: false.
   */
  global?: boolean;
}

export const TRUSTED_PROXY_HOPS_ENV = "RATE_LIMIT_TRUSTED_PROXY_HOPS";

/**
 * Strictly parse RATE_LIMIT_TRUSTED_PROXY_HOPS. Returns `undefined` when unset
 * or empty (callers decide whether that's allowed — required in production,
 * defaults to 0 elsewhere). Throws RangeError on anything that isn't a
 * non-negative integer, so a typo like `abc` or `-1` is never silently coerced
 * to 0 (which would mean "no proxy" — exactly wrong behind a load balancer).
 *
 * `parseInt` is too lenient (`parseInt("1abc")` is 1), so we validate the raw
 * string against a digits-only pattern.
 */
export function parseTrustedProxyHopsEnv(): number | undefined {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(
      `${TRUSTED_PROXY_HOPS_ENV} must be a non-negative integer (got "${raw}")`,
    );
  }
  return parseInt(trimmed, 10);
}

/**
 * Resolve the hop count for limiter construction (runs in every environment).
 * Never throws: an invalid value is logged and treated as 0. In production
 * validateRateLimitConfig() rejects an invalid value at startup before any
 * limiter is built, so this fallback only applies in dev/test — where a loud
 * warn is enough to surface the misconfiguration.
 */
function envTrustedProxyHops(): number {
  try {
    return parseTrustedProxyHopsEnv() ?? 0;
  } catch {
    logger.warn(`${TRUSTED_PROXY_HOPS_ENV} is invalid — falling back to 0 (no proxy)`, {
      component: "rate-limit",
      value: process.env[TRUSTED_PROXY_HOPS_ENV],
    });
    return 0;
  }
}

/**
 * Validate rate-limiter configuration at startup. Mirrors
 * validateApiKeyConfig(): in production we refuse to start with an *undefined*
 * trust-proxy posture. The silent default (use the socket peer) collapses
 * every client into one bucket when the server sits behind a load balancer —
 * the per-IP limiter becomes a single global bucket that one noisy client, or
 * an attacker, can exhaust for everyone. Forcing an explicit value (even 0,
 * for direct exposure) removes that footgun.
 *
 * Call before binding the server.
 */
export function validateRateLimitConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  let hops: number | undefined;
  try {
    hops = parseTrustedProxyHopsEnv();
  } catch (err) {
    logger.fatal((err as Error).message, {
      component: "rate-limit",
      value: process.env[TRUSTED_PROXY_HOPS_ENV],
    });
    process.exit(1);
  }
  if (hops === undefined) {
    logger.fatal(
      `${TRUSTED_PROXY_HOPS_ENV} is not set; refusing to start in production with an ` +
        `undefined trust-proxy posture. Set it to the number of trusted reverse-proxy ` +
        `hops in front of this server (0 for direct exposure).`,
      { component: "rate-limit" },
    );
    process.exit(1);
  }
  logger.info("rate-limit trust-proxy posture", {
    component: "rate-limit",
    trusted_proxy_hops: hops,
  });
}

/**
 * Resolve the client IP used as the per-IP bucket key.
 *
 * With `hops > 0` the address is taken from `X-Forwarded-For` counting `hops`
 * entries from the right (see RateLimitOptions.trustedProxyHops). If the header
 * is missing or has fewer entries than the configured chain, the request did
 * not traverse the expected proxies (a direct hit or a spoof attempt) — we do
 * NOT trust a partial chain and fall back to the socket peer.
 */
function resolveClientIp(c: Context, hops: number): string {
  if (hops > 0) {
    const list =
      c.req
        .header("x-forwarded-for")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const idx = list.length - hops;
    if (idx >= 0 && idx < list.length) return list[idx];
    logger.warn("X-Forwarded-For shorter than trustedProxyHops — using socket peer", {
      component: "rate-limit",
      trusted_proxy_hops: hops,
      xff_entries: list.length,
    });
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // getConnInfo fails without a real socket (tests, non-Node adapters).
    // Fall back to a sentinel distinct from the "global" mode key so the
    // per-IP and global buckets never collide if a bucket store is ever
    // shared across middleware instances.
    logger.warn("could not resolve client IP — using shared bucket", {
      component: "rate-limit",
    });
    return "unknown";
  }
}

/**
 * Simple in-memory sliding-window rate limiter (token bucket variant).
 *
 * Each unique client IP gets a bucket that refills at a constant rate.
 * When the bucket is empty the request is rejected with 429.
 *
 * NOT suitable for multi-process / clustered deployments: buckets live in this
 * process only, so N replicas yield an effective limit of N × `limit`. Use a
 * shared store (Redis or similar) for coordinated limiting across replicas.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, global: globalBucket = false } = opts;
  const hops = opts.trustedProxyHops ?? envTrustedProxyHops();
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

    // global: all clients share one bucket (for process-wide limits).
    // otherwise: per-client, keyed on the resolved client IP.
    const key = globalBucket ? "global" : resolveClientIp(c, hops);

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
