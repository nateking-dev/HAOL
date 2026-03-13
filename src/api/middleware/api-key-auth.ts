import type { MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Bearer-token API key auth middleware.
 * Checks the HAOL_API_KEY env var. If unset, auth is disabled (development mode).
 * Expects: Authorization: Bearer <key>
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const expected = process.env.HAOL_API_KEY;
  if (!expected) {
    // No key configured — auth disabled (dev mode)
    await next();
    return;
  }

  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }

  const provided = header.slice(7);
  if (!safeCompare(provided, expected)) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  await next();
};
