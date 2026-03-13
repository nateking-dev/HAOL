import { Hono } from "hono";
import { requestId } from "./middleware/request-id.js";
import { apiKeyAuth } from "./middleware/api-key-auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { health } from "./routes/health.js";
import { agents } from "./routes/agents.js";
import { tasks } from "./routes/tasks.js";
import { observability } from "./routes/observability.js";
import { outcomes } from "./routes/outcomes.js";

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
  app.route("/", agents);
  app.route("/", tasks);
  app.route("/", observability);
  app.route("/", outcomes);

  // Error handler
  app.onError(errorHandler);

  return app;
}
