import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  errorHandler,
  ValidationError,
  NotFoundError,
  NoAgentAvailableError,
  rejectInvalidBody,
} from "../../../src/api/middleware/error-handler.js";
import { _setDestinationForTests } from "../../../src/logging/logger.js";
import { CaptureStream, LogLevel, setLogLevel } from "../../helpers/capture-stream.js";

function buildAppThatThrows(err: unknown) {
  const app = new Hono();
  app.get("/boom", () => {
    throw err;
  });
  app.onError(errorHandler);
  return app;
}

describe("errorHandler", () => {
  let capture: CaptureStream;
  let restoreLogLevel: () => void;

  beforeEach(() => {
    // Capture structured logs from the 500 path so we can assert against them.
    restoreLogLevel = setLogLevel("trace");
    capture = new CaptureStream();
    _setDestinationForTests(capture);
  });

  afterEach(() => {
    _setDestinationForTests(undefined);
    restoreLogLevel();
  });

  it("maps ValidationError to 400 with the original message", async () => {
    const app = buildAppThatThrows(new ValidationError("bad input shape"));
    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad input shape" });
  });

  it("fails closed on a raw ZodError: generic message, issue tree logged not returned", async () => {
    // Routes should funnel validation through rejectInvalidBody, but if a raw
    // ZodError ever bubbles up we must not echo the issue tree to the client.
    const schema = z.object({ secretField: z.number() });
    const parsed = schema.safeParse({ secretField: "nope" });
    const zodError = parsed.success ? null : parsed.error;
    expect(zodError).toBeInstanceOf(z.ZodError);

    const app = buildAppThatThrows(zodError);
    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details?: unknown };
    expect(body.error).toBe("invalid request body");
    // The internal schema/field names must not leak in the response.
    expect(JSON.stringify(body)).not.toMatch(/secretField/);
    expect(body.details).toBeUndefined();
    // But the tree is logged server-side for operators.
    const warns = capture.records(LogLevel.WARN);
    expect(warns.some((r) => r.msg === "unhandled zod validation error")).toBe(true);
  });

  it("rejectInvalidBody throws a generic ValidationError and logs the issue tree", async () => {
    const schema = z.object({ promptField: z.string() });
    const parsed = schema.safeParse({ promptField: 123 });
    const zodError = parsed.success ? null : parsed.error;

    const app = new Hono();
    app.get("/boom", () => {
      rejectInvalidBody(zodError!);
    });
    app.onError(errorHandler);

    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid request body");
    expect(JSON.stringify(body)).not.toMatch(/promptField/);
    // Detailed issues are logged for debugging, not returned.
    const warns = capture.records(LogLevel.WARN);
    const rec = warns.find((r) => r.msg === "request body validation failed");
    expect(rec).toBeDefined();
    expect(JSON.stringify(rec)).toMatch(/promptField/);
  });

  it("maps NotFoundError to 404", async () => {
    const app = buildAppThatThrows(new NotFoundError("Task not found: abc"));
    const res = await app.request("/boom");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Task not found: abc" });
  });

  it("maps NoAgentAvailableError to 503 with the default message when none given", async () => {
    const app = buildAppThatThrows(new NoAgentAvailableError());
    const res = await app.request("/boom");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "No suitable agent available" });
  });

  it("maps NoAgentAvailableError with a custom message", async () => {
    const app = buildAppThatThrows(new NoAgentAvailableError("All providers down"));
    const res = await app.request("/boom");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "All providers down" });
  });

  it("maps mysql2 ER_DUP_ENTRY to 409 with a generic message (no leakage)", async () => {
    // Simulate a mysql2 error: an Error with a `code` property set by the driver.
    const dupError = Object.assign(new Error("Duplicate entry 'foo' for key 'agent_id'"), {
      code: "ER_DUP_ENTRY",
    });
    const app = buildAppThatThrows(dupError);
    const res = await app.request("/boom");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Resource already exists");
    // Verify the original (potentially sensitive) message did not leak through.
    expect(body.error).not.toMatch(/Duplicate entry/);
    expect(body.error).not.toMatch(/agent_id/);
  });

  it("maps unknown errors to 500 with a generic message and logs internally", async () => {
    const app = buildAppThatThrows(new Error("internal: db password is hunter2"));
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Internal server error");
    // Sensitive internal detail must not leak in the response body.
    expect(body.error).not.toMatch(/hunter2/);
    // But it should be logged as a structured error so operators can debug.
    const errors = capture.records(LogLevel.ERROR);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ msg: "unhandled error" });
  });

  it("does not log when the error type is recognized", async () => {
    const app = buildAppThatThrows(new NotFoundError("missing"));
    await app.request("/boom");
    expect(capture.records(LogLevel.ERROR)).toHaveLength(0);
  });
});
