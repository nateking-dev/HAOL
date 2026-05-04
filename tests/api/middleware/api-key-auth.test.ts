import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { createApiKeyAuth } from "../../../src/api/middleware/api-key-auth.js";
import { _setDestinationForTests } from "../../../src/logging/logger.js";

class CaptureStream extends Writable {
  lines: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.lines.push(chunk.toString());
    cb();
  }
  records(level?: number): Array<Record<string, unknown>> {
    const recs = this.lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return level === undefined ? recs : recs.filter((r) => r.level === level);
  }
}

function buildApp() {
  const app = new Hono();
  app.use("/protected/*", createApiKeyAuth());
  app.get("/protected/ping", (c) => c.json({ ok: true }));
  app.get("/open", (c) => c.json({ ok: true }));
  return app;
}

describe("createApiKeyAuth", () => {
  let capture: CaptureStream;

  beforeEach(() => {
    process.env.LOG_LEVEL = "trace";
    capture = new CaptureStream();
    _setDestinationForTests(capture);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _setDestinationForTests(undefined);
  });

  afterAll(() => {
    delete process.env.LOG_LEVEL;
  });

  describe("when HAOL_API_KEY is unset", () => {
    beforeEach(() => {
      vi.stubEnv("HAOL_API_KEY", "");
    });

    it("allows the request through", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("logs the dev-mode warning exactly once across multiple requests", async () => {
      const app = buildApp();
      await app.request("/protected/ping");
      await app.request("/protected/ping");
      await app.request("/protected/ping");
      const warns = capture.records(40);
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/HAOL_API_KEY is not set/);
    });

    it("scopes the once-per-instance warning to the middleware factory", async () => {
      // Each createApp() should get its own warning state — confirmed by
      // building a second app with its own auth instance.
      const appA = buildApp();
      const appB = buildApp();
      await appA.request("/protected/ping");
      await appB.request("/protected/ping");
      expect(capture.records(40)).toHaveLength(2);
    });
  });

  describe("when HAOL_API_KEY is set", () => {
    const SECRET = "super-secret-token-abc123";

    beforeEach(() => {
      vi.stubEnv("HAOL_API_KEY", SECRET);
    });

    it("rejects with 401 when no Authorization header is present", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "Missing or malformed Authorization header",
      });
    });

    it("rejects with 401 when Authorization scheme is not Bearer", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping", {
        headers: { Authorization: `Basic ${SECRET}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the bearer token is wrong", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid API key" });
    });

    it("rejects with 401 when the bearer token differs only by length", async () => {
      // Tokens are hashed before timingSafeEqual — verify length differences
      // don't slip through (a naive eq comparison would also reject, but a
      // direct timingSafeEqual without hashing would throw on length mismatch).
      const app = buildApp();
      const res = await app.request("/protected/ping", {
        headers: { Authorization: `Bearer ${SECRET}-extra` },
      });
      expect(res.status).toBe(401);

      const res2 = await app.request("/protected/ping", {
        headers: { Authorization: `Bearer ${SECRET.slice(0, -1)}` },
      });
      expect(res2.status).toBe(401);
    });

    it("rejects with 401 on empty bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping", {
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the correct bearer token", async () => {
      const app = buildApp();
      const res = await app.request("/protected/ping", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("does not log the dev-mode warning when auth is enforced", async () => {
      const app = buildApp();
      await app.request("/protected/ping", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(capture.records(40)).toHaveLength(0);
    });

    it("does not gate routes outside the configured prefix", async () => {
      // /open is not behind the middleware; verify it still works without auth.
      const app = buildApp();
      const res = await app.request("/open");
      expect(res.status).toBe(200);
    });
  });
});

describe("validateApiKeyConfig", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit is captured as a no-op so the test process survives the
    // call; we assert on the call args instead.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    exitSpy.mockRestore();
  });

  it("exits with code 1 in production when HAOL_API_KEY is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HAOL_API_KEY", "");
    process.env.LOG_LEVEL = "trace";
    // Re-import with fresh module state so the IS_PRODUCTION constant is
    // re-evaluated against the stubbed env. The logger module also reloads
    // here, so we must rebind the test destination to the fresh instance.
    vi.resetModules();
    const capture = new CaptureStream();
    const logging = await import("../../../src/logging/logger.js");
    logging._setDestinationForTests(capture);
    const { validateApiKeyConfig } = await import("../../../src/api/middleware/api-key-auth.js");
    expect(() => validateApiKeyConfig()).toThrow(/process\.exit\(1\)/);
    const fatals = capture.records(60);
    expect(fatals.length).toBeGreaterThan(0);
    expect(fatals[0].msg).toMatch(/HAOL_API_KEY is not set/);
    logging._setDestinationForTests(undefined);
    delete process.env.LOG_LEVEL;
  });

  it("does not exit in production when HAOL_API_KEY is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HAOL_API_KEY", "some-key");
    vi.resetModules();
    const { validateApiKeyConfig } = await import("../../../src/api/middleware/api-key-auth.js");
    expect(() => validateApiKeyConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit outside production even when HAOL_API_KEY is unset", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("HAOL_API_KEY", "");
    vi.resetModules();
    const { validateApiKeyConfig } = await import("../../../src/api/middleware/api-key-auth.js");
    expect(() => validateApiKeyConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
