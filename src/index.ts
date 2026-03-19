import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool, healthCheck } from "./db/connection.js";
import { createApp } from "./api/app.js";
import { validateApiKeyConfig } from "./api/middleware/api-key-auth.js";

async function main() {
  // Fail fast if production auth is misconfigured — before binding the server.
  validateApiKeyConfig();

  const config = loadConfig();
  createPool(config.dolt);

  const healthy = await healthCheck();
  if (healthy) {
    console.log("HAOL connected to Dolt at %s:%d", config.dolt.host, config.dolt.port);
  } else {
    console.error("Failed to connect to Dolt at %s:%d", config.dolt.host, config.dolt.port);
    process.exit(1);
  }

  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);

  serve({ fetch: app.fetch, port }, (info) => {
    console.log("HAOL API server listening on http://localhost:%d", info.port);
  });
}

main();
