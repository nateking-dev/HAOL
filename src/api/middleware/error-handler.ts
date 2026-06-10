import type { Context } from "hono";
import { z } from "zod";
import { logger } from "../../logging/logger.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Convert a Zod validation failure into a client-safe ValidationError. The
 * issue tree echoes input fragments back to the caller and exposes internal
 * schema structure, so we log it server-side only and throw a generic
 * message. See issue #72 (audit M17).
 */
export function rejectInvalidBody(error: z.ZodError): never {
  logger.warn("request body validation failed", {
    component: "http",
    issues: error.issues,
  });
  throw new ValidationError("invalid request body");
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
  // A raw ZodError should never reach here — routes are expected to funnel
  // validation failures through rejectInvalidBody — but if one slips past
  // (e.g. a .parse() somewhere), fail closed: log the tree, return generic.
  if (err instanceof z.ZodError) {
    logger.warn("unhandled zod validation error", {
      component: "http",
      issues: err.issues,
    });
    return c.json({ error: "invalid request body" }, 400);
  }

  if (err instanceof ValidationError) {
    return c.json({ error: err.message }, 400);
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
