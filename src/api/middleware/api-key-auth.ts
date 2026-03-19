import type { MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const isProduction = () => process.env.NODE_ENV === "production";

let devWarningLogged = false;

/**
 * Bearer-token API key auth middleware.
 * Checks the HAOL_API_KEY env var.
 *
 * Production: if HAOL_API_KEY is unset, rejects ALL requests with 503.
 * Non-production: if HAOL_API_KEY is unset, allows requests but logs a
 * warning on the first unauthenticated request.
 *
 * Expects: Authorization: Bearer <key>
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const expected = process.env.HAOL_API_KEY;

  if (!expected) {
    if (isProduction()) {
      console.error("[SECURITY] HAOL_API_KEY is not set in production. Rejecting request.");
      return c.json({ error: "Service unavailable" }, 503);
    }

    // Non-production: warn once, then allow
    if (!devWarningLogged) {
      console.warn(
        "[WARN] HAOL_API_KEY is not set — auth is disabled. Set HAOL_API_KEY to enable authentication.",
      );
      devWarningLogged = true;
    }
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
