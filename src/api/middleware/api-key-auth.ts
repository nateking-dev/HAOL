import type { MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Validate that HAOL_API_KEY is set in production.
 * Call this at startup before binding the server — failing fast
 * avoids serving unauthenticated requests.
 */
export function validateApiKeyConfig(): void {
  if (IS_PRODUCTION && !process.env.HAOL_API_KEY) {
    console.error("[FATAL] HAOL_API_KEY is not set. Refusing to start in production without auth.");
    process.exit(1);
  }
}

/**
 * Create a Bearer-token API key auth middleware.
 * Returns a factory so each createApp() call gets its own state,
 * keeping tests isolated.
 *
 * Non-production: if HAOL_API_KEY is unset, allows requests but
 * logs a warning on the first unauthenticated request.
 *
 * Expects: Authorization: Bearer <key>
 */
export function createApiKeyAuth(): MiddlewareHandler {
  let devWarningLogged = false;

  return async (c, next) => {
    const expected = process.env.HAOL_API_KEY;

    if (!expected) {
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
}
