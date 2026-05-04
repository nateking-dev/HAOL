import type { Context } from "hono";
import { logger } from "../../logging/logger.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class NoAgentAvailableError extends Error {
  constructor(message: string = "No suitable agent available") {
    super(message);
    this.name = "NoAgentAvailableError";
  }
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ValidationError || err.name === "ZodError") {
    return c.json(
      {
        error: err.message,
        details: "details" in err ? (err as Record<string, unknown>).details : undefined,
      },
      400,
    );
  }

  if (err instanceof NotFoundError) {
    return c.json({ error: err.message }, 404);
  }

  if (err instanceof NoAgentAvailableError) {
    return c.json({ error: err.message }, 503);
  }

  if ("code" in err && (err as { code: string }).code === "ER_DUP_ENTRY") {
    return c.json({ error: "Resource already exists" }, 409);
  }

  logger.error("unhandled error", {
    component: "http",
    error: err.message,
    name: err.name,
    stack: err.stack,
  });
  return c.json({ error: "Internal server error" }, 500);
}
