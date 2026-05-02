import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

const MAX_LEN = 128;
// Strip ASCII control characters (incl. CR/LF) to prevent log-injection from
// untrusted X-Request-ID headers. If sanitization leaves nothing, generate a
// fresh UUID rather than emit an empty header.
function sanitize(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_LEN);
  return cleaned.length > 0 ? cleaned : randomUUID();
}

export const requestId: MiddlewareHandler = async (c, next) => {
  const supplied = c.req.header("X-Request-ID");
  const id = supplied ? sanitize(supplied) : randomUUID();
  c.set("requestId", id);
  c.header("X-Request-ID", id);
  await next();
};
