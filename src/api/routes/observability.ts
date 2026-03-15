import { Hono } from "hono";
import {
  costByAgent,
  avgLatencyByAgent,
  failureRate,
  tasksByTier,
  costCeilingBreaches,
  agentRegistryDiff,
  commitHistory,
  outcomeSignalRates,
  routingAccuracyByAgent,
} from "../../observability/queries.js";
import { getDashboard } from "../../observability/dashboard.js";
import {
  cleanupOrphanedPendingRecords,
  countOrphanedPendingRecords,
} from "../../repositories/task-outcome.js";
import { doltCommit } from "../../db/dolt.js";
import { tune, recentTuningRuns } from "../../services/routing-tuner.js";

const observability = new Hono();

const MAX_HOURS = 8760; // 1 year

function parseIntParam(val: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(val ?? String(def), 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// --- Stats routes ---

observability.get("/stats", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const dashboard = await getDashboard(hours);
  return c.json(dashboard, 200);
});

observability.get("/stats/cost", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await costByAgent(hours);
  return c.json(data, 200);
});

observability.get("/stats/latency", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await avgLatencyByAgent(hours);
  return c.json(data, 200);
});

observability.get("/stats/failures", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await failureRate(hours);
  return c.json(data, 200);
});

observability.get("/stats/tiers", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await tasksByTier(hours);
  return c.json(data, 200);
});

observability.get("/stats/breaches", async (c) => {
  const data = await costCeilingBreaches();
  return c.json(data, 200);
});

observability.get("/stats/outcomes", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await outcomeSignalRates(hours);
  return c.json(data, 200);
});

observability.get("/stats/routing-accuracy", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 24, 1, MAX_HOURS);
  const data = await routingAccuracyByAgent(hours);
  return c.json(data, 200);
});

observability.get("/stats/orphaned-pending", async (c) => {
  const maxAgeHours = parseIntParam(c.req.query("max_age_hours"), 24, 1, MAX_HOURS);
  const count = await countOrphanedPendingRecords(maxAgeHours);
  return c.json({ orphaned_pending: count, max_age_hours: maxAgeHours }, 200);
});

// --- Maintenance routes ---

observability.post("/maintenance/cleanup-pending", async (c) => {
  const maxAgeHours = parseIntParam(c.req.query("max_age_hours"), 24, 1, MAX_HOURS);
  const deleted = await cleanupOrphanedPendingRecords(maxAgeHours);
  let committed: boolean | null = null;
  if (deleted > 0) {
    committed = true;
    try {
      await doltCommit({
        message: `maintenance:cleanup | deleted ${deleted} orphaned evaluation_pending records older than ${maxAgeHours}h`,
        author: "haol-maintenance <haol@system>",
      });
    } catch (err) {
      committed = false;
      console.error("doltCommit failed after cleanup-pending:", err);
    }
  }
  return c.json({ deleted, max_age_hours: maxAgeHours, committed }, 200);
});

// --- Tuning routes ---

observability.post("/tune", async (c) => {
  const hours = parseIntParam(c.req.query("hours"), 72, 1, MAX_HOURS);
  const dryRun = c.req.query("dry_run") === "true";
  try {
    const result = await tune({ hours, dryRun });
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tuning failed";
    return c.json({ error: message }, 500);
  }
});

observability.get("/tune/history", async (c) => {
  const limit = parseIntParam(c.req.query("limit"), 10, 1, 100);
  try {
    const runs = await recentTuningRuns(limit);
    return c.json(runs, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch tuning history";
    return c.json({ error: message }, 500);
  }
});

// --- Audit routes ---

observability.get("/audit/agents", async (c) => {
  const since = c.req.query("since") ?? "7d";
  const data = await agentRegistryDiff(since);
  return c.json(data, 200);
});

observability.get("/audit/commits", async (c) => {
  const limit = parseIntParam(c.req.query("limit"), 50, 1, 1000);
  const data = await commitHistory(limit);
  return c.json(data, 200);
});

export { observability };
