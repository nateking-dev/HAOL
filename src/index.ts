import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool, healthCheck } from "./db/connection.js";
import { createApp } from "./api/app.js";
import { validateApiKeyConfig } from "./api/middleware/api-key-auth.js";
import * as worker from "./services/task-worker.js";
import { startReaper, stopReaper, runReaperOnce } from "./services/task-reaper.js";

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

  worker.start();
  // One-shot recovery sweep for tasks stranded by a previous crash, then
  // start the periodic reaper. Both run before we begin accepting traffic so
  // a crash-loop can't pile up untouched stale rows.
  await runReaperOnce();
  startReaper();

  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log("HAOL API server listening on http://localhost:%d", info.port);
  });

  const shutdown = async (signal: string) => {
    console.log("[server] received %s, draining…", signal);
    stopReaper();
    // Await server.close so any in-flight POST handlers between the
    // createQueued INSERT and worker.enqueue() can finish before the
    // worker stops accepting new enqueues. Without this, a late enqueue
    // would be rejected and the row stranded as QUEUED until the next
    // reaper sweep on restart.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main();
