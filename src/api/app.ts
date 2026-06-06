import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { requestId } from "./middleware/request-id.js";
import { createApiKeyAuth } from "./middleware/api-key-auth.js";
import { rateLimit, parseTrustedProxyHopsEnv } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { health } from "./routes/health.js";
import { agents } from "./routes/agents.js";
import { tasks } from "./routes/tasks.js";
import { observability } from "./routes/observability.js";
import { outcomes } from "./routes/outcomes.js";
import { demo } from "./routes/demo.js";

// Rate-limit presets
const readLimit = rateLimit({ limit: 120, windowMs: 60_000 }); // 120 req/min
const taskWriteLimit = rateLimit({ limit: 30, windowMs: 60_000 }); // 30 req/min
// Tune is limited to 1 req/5min with a single shared bucket (global: true)
// because tuning acquires a DB advisory lock, runs LLM evaluation, and
// mutates routing rules. Per-IP would allow concurrent clients to queue up
// requests that just block on the lock.
const tuneLimit = rateLimit({ limit: 1, windowMs: 5 * 60_000, global: true });

export function createApp(): Hono {
  // Defense-in-depth: if someone calls createApp() without the startup
  // guard (tests, alternate entry points), throw rather than serve
  // unauthenticated in production.
  if (process.env.NODE_ENV === "production" && !process.env.HAOL_API_KEY) {
    throw new Error("HAOL_API_KEY must be set in production");
  }
  // Likewise refuse to serve with an undefined (or invalid) trust-proxy
  // posture in production — an unset value silently degrades per-IP limiting
  // to a single global bucket behind a load balancer, and an invalid value
  // falls back to the same hops=0 footgun. Must be set explicitly (0 = direct
  // exposure). Shares parseTrustedProxyHopsEnv() with validateRateLimitConfig()
  // so both paths reject the same inputs; parse throws RangeError on an invalid
  // value, undefined means unset.
  if (process.env.NODE_ENV === "production" && parseTrustedProxyHopsEnv() === undefined) {
    throw new Error("RATE_LIMIT_TRUSTED_PROXY_HOPS must be set in production");
  }

  const app = new Hono();
  const apiKeyAuth = createApiKeyAuth();

  // Middleware
  app.use("*", requestId);

  // Demo UI is opt-in. It exposes an unauthenticated path to the router
  // (paid LLM calls) and is intended for live demos / local dev only.
  // Production deployments must explicitly set HAOL_ENABLE_DEMO=1.
  //
  // Demo write bucket is allocated per-app so multiple app instances (tests,
  // hot reload) don't share state. Tight, process-wide (global: true): the
  // route is unauthenticated, so per-IP would let an attacker spread spend
  // across rotating addresses. 5/min globally bounds worst-case LLM spend.
  if (process.env.HAOL_ENABLE_DEMO === "1") {
    const demoWriteLimit = rateLimit({ limit: 5, windowMs: 60_000, global: true });
    // serveStatic is bound to GET only. app.use("/demo/*", ...) would run
    // the static handler on POST as well — a POST /demo/api/task with a
    // matching ./public/api/task file would be served statically and never
    // reach the rate limiter, defeating the spend cap.
    app.get(
      "/demo/*",
      serveStatic({ root: "./public/", rewriteRequestPath: (p) => p.replace(/^\/demo/, "") }),
    );
    app.post("/demo/api/task", demoWriteLimit);
    app.get("/demo/api/savings", readLimit);
    app.route("/", demo);
  }

  // Health check is unversioned (load balancers, K8s probes) and unauthenticated.
  // Reserved unversioned root for cross-version concerns (health, future
  // discovery endpoints) — versioned API surface lives under /v1.
  app.route("/", health);

  // Protected routes require API key auth (when HAOL_API_KEY is set)
  app.use("/v1/tasks/*", apiKeyAuth);
  app.use("/v1/agents/*", apiKeyAuth);
  app.use("/v1/observability/*", apiKeyAuth);

  // Rate limiting — applied after auth so unauthenticated requests
  // are rejected before consuming rate-limit tokens.
  // Use wildcard patterns so future sub-routes are also covered.
  app.post("/v1/tasks/*", taskWriteLimit);
  app.post("/v1/observability/tune", tuneLimit);

  // Read limiters use app.get() so they don't double-count POST requests
  // that already have their own write limiters above.
  app.get("/v1/tasks/*", readLimit);
  app.get("/v1/agents/*", readLimit);
  app.get("/v1/observability/*", readLimit);

  app.route("/v1", agents);
  app.route("/v1", tasks);
  app.route("/v1/observability", observability);
  app.route("/v1", outcomes);

  // Error handler
  app.onError(errorHandler);

  return app;
}
