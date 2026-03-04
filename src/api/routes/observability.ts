import { Hono } from "hono";
import {
  costByAgent,
  avgLatencyByAgent,
  failureRate,
  tasksByTier,
  costCeilingBreaches,
  agentRegistryDiff,
  commitHistory,
} from "../../observability/queries.js";
import { getDashboard } from "../../observability/dashboard.js";

const observability = new Hono();

// --- Stats routes ---

observability.get("/stats", async (c) => {
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const dashboard = await getDashboard(hours);
  return c.json(dashboard, 200);
});

observability.get("/stats/cost", async (c) => {
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const data = await costByAgent(hours);
  return c.json(data, 200);
});

observability.get("/stats/latency", async (c) => {
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const data = await avgLatencyByAgent(hours);
  return c.json(data, 200);
});

observability.get("/stats/failures", async (c) => {
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const data = await failureRate(hours);
  return c.json(data, 200);
});

observability.get("/stats/tiers", async (c) => {
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const data = await tasksByTier(hours);
  return c.json(data, 200);
});

observability.get("/stats/breaches", async (c) => {
  const data = await costCeilingBreaches();
  return c.json(data, 200);
});

// --- Audit routes ---

observability.get("/audit/agents", async (c) => {
  const since = c.req.query("since") ?? "7d";
  const data = await agentRegistryDiff(since);
  return c.json(data, 200);
});

observability.get("/audit/commits", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const data = await commitHistory(limit);
  return c.json(data, 200);
});

export { observability };
