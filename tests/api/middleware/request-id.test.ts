import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestId } from "../../../src/api/middleware/request-id.js";

function buildApp() {
  const app = new Hono();
  app.use("*", requestId);
  app.get("/echo", (c) => c.json({ id: c.get("requestId") }));
  return app;
}

describe("requestId middleware", () => {
  it("generates a UUID when no X-Request-ID header is supplied", async () => {
    const app = buildApp();
    const res = await app.request("/echo");
    const id = res.headers.get("X-Request-ID");
    expect(id).toBeTruthy();
    // RFC 4122 v4-ish: 8-4-4-4-12 hex with dashes.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await res.json()).id).toBe(id);
  });

  it("passes through a supplied X-Request-ID unchanged", async () => {
    const app = buildApp();
    const res = await app.request("/echo", {
      headers: { "X-Request-ID": "custom-correlation-id-123" },
    });
    expect(res.headers.get("X-Request-ID")).toBe("custom-correlation-id-123");
    expect((await res.json()).id).toBe("custom-correlation-id-123");
  });

  it("generates a fresh ID on each request when none supplied", async () => {
    const app = buildApp();
    const id1 = (await app.request("/echo")).headers.get("X-Request-ID");
    const id2 = (await app.request("/echo")).headers.get("X-Request-ID");
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});
