import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestId } from "../../../src/api/middleware/request-id.js";
import { getContext } from "../../../src/logging/context.js";

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

  describe("sanitization", () => {
    // Note: the Web Headers constructor rejects header values containing
    // \r/\n outright, so well-behaved fetch clients can't even construct a
    // CRLF-injected request. The sanitization here is defense-in-depth for
    // non-conforming clients, proxies, or alternate transports — and it's
    // exercised below with control chars that Headers does allow through.

    it("strips ASCII control characters from supplied IDs", async () => {
      const app = buildApp();
      const dirty = "trace-\x01abc\x07def\x1fghi\x7f";
      const res = await app.request("/echo", { headers: { "X-Request-ID": dirty } });
      const id = res.headers.get("X-Request-ID")!;
      expect(id).toBe("trace-abcdefghi");
      // Belt-and-braces: response must contain no control chars at all.
      // eslint-disable-next-line no-control-regex
      expect(id).not.toMatch(/[\x00-\x1f\x7f]/);
    });

    it("caps overlong IDs at 128 characters", async () => {
      const app = buildApp();
      const huge = "a".repeat(500);
      const res = await app.request("/echo", { headers: { "X-Request-ID": huge } });
      const id = res.headers.get("X-Request-ID")!;
      expect(id.length).toBe(128);
      expect(id).toBe("a".repeat(128));
    });

    it("generates a fresh UUID when the supplied ID is entirely control characters", async () => {
      const app = buildApp();
      const onlyControl = "\x01\x02\x03\x07\x1f\x7f";
      const res = await app.request("/echo", {
        headers: { "X-Request-ID": onlyControl },
      });
      const id = res.headers.get("X-Request-ID")!;
      // Sanitized to empty → middleware generates a UUID instead.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("preserves clean IDs untouched", async () => {
      // Sanitization must not damage well-formed correlation IDs from upstream.
      const app = buildApp();
      const clean = "req_2026-05-02_abcdef-0123";
      const res = await app.request("/echo", { headers: { "X-Request-ID": clean } });
      expect(res.headers.get("X-Request-ID")).toBe(clean);
    });
  });

  describe("AsyncLocalStorage propagation", () => {
    it("binds request_id into AsyncLocalStorage for handler/log code", async () => {
      // Anything calling getContext() or logger.* during the request must see
      // the same id as the X-Request-ID header — that's the whole point of
      // structured logging with request correlation.
      const app = new Hono();
      app.use("*", requestId);
      app.get("/ctx", (c) => c.json({ header: c.get("requestId"), als: getContext().request_id }));

      const res = await app.request("/ctx", {
        headers: { "X-Request-ID": "req-correlation-test" },
      });
      const body = (await res.json()) as { header: string; als: string };
      expect(body.als).toBe("req-correlation-test");
      expect(body.als).toBe(body.header);
    });

    it("does not leak request_id outside the request's async scope", async () => {
      const app = new Hono();
      app.use("*", requestId);
      app.get("/ping", (c) => c.json({ ok: true }));

      await app.request("/ping", { headers: { "X-Request-ID": "req-leak-check" } });
      // After the request completes, the outer scope must have no context.
      expect(getContext().request_id).toBeUndefined();
    });
  });
});
