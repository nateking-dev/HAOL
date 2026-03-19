import { Hono } from "hono";
import { requestId } from "./middleware/request-id.js";
import { apiKeyAuth } from "./middleware/api-key-auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { health } from "./routes/health.js";
import { agents } from "./routes/agents.js";
import { tasks } from "./routes/tasks.js";
import { observability } from "./routes/observability.js";
import { outcomes } from "./routes/outcomes.js";

// Rate-limit presets
const readLimit = rateLimit({ limit: 120, windowMs: 60_000 }); // 120 req/min
const taskWriteLimit = rateLimit({ limit: 30, windowMs: 60_000 }); // 30 req/min
const tuneLimit = rateLimit({ limit: 1, windowMs: 5 * 60_000 }); // 1 req/5 min

export function createApp(): Hono {
  const app = new Hono();

  // Middleware
  app.use("*", requestId);

  // Health check is unauthenticated (load balancers, K8s probes)
  app.route("/", health);

  // Protected routes require API key auth (when HAOL_API_KEY is set)
  app.use("/tasks/*", apiKeyAuth);
  app.use("/agents/*", apiKeyAuth);
  app.use("/observability/*", apiKeyAuth);

  // Rate limiting — applied after auth so unauthenticated requests
  // are rejected before consuming rate-limit tokens.
  app.post("/tasks", taskWriteLimit);
  app.post("/observability/tune", tuneLimit);
  app.use("/tasks/*", readLimit);
  app.use("/agents/*", readLimit);
  app.use("/observability/*", readLimit);

  app.route("/", agents);
  app.route("/", tasks);
  app.route("/observability", observability);
  app.route("/", outcomes);

  // Error handler
  app.onError(errorHandler);

  return app;
}
