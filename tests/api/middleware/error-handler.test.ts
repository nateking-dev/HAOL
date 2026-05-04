import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  errorHandler,
  ValidationError,
  NotFoundError,
  NoAgentAvailableError,
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
    expect(await res.json()).toEqual({ error: "bad input shape", details: undefined });
  });

  it("maps a ZodError (by name) to 400", async () => {
    // The handler matches by err.name === "ZodError" so it works whether the
    // app throws a real ZodError or a wrapped one with the same name.
    const schema = z.object({ count: z.number() });
    const parsed = schema.safeParse({ count: "nope" });
    expect(parsed.success).toBe(false);
    const zodError = parsed.success ? null : parsed.error;
    expect(zodError?.name).toBe("ZodError");

    const app = buildAppThatThrows(zodError);
    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("forwards a `details` field on validation errors when present", async () => {
    class DetailedValidationError extends ValidationError {
      details: unknown;
      constructor(message: string, details: unknown) {
        super(message);
        this.details = details;
      }
    }
    const app = buildAppThatThrows(new DetailedValidationError("bad", { field: "x" }));
    const res = await app.request("/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad", details: { field: "x" } });
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
