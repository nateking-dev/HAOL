import { Hono } from "hono";
import { healthCheck } from "../../db/connection.js";

const health = new Hono();

health.get("/health", async (c) => {
  const ok = await healthCheck();
  if (ok) {
    return c.json({ status: "ok", dolt: "connected" }, 200);
  }
  return c.json({ status: "error", dolt: "disconnected" }, 503);
});

export { health };
