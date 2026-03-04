import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = c.req.header("X-Request-ID") ?? randomUUID();
  c.set("requestId", id);
  c.header("X-Request-ID", id);
  await next();
};
