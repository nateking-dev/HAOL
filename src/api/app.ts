import { Hono } from "hono";
import { requestId } from "./middleware/request-id.js";
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

  // Routes
  app.route("/", health);
  app.route("/", agents);
  app.route("/", tasks);
  app.route("/", observability);
  app.route("/", outcomes);

  // Error handler
  app.onError(errorHandler);

  return app;
}
