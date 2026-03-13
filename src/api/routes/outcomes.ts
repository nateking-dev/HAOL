import { Hono } from "hono";
import { DownstreamOutcomeInput } from "../../types/outcome.js";
import { recordDownstreamOutcome } from "../../services/outcome-collector.js";
import * as outcomeRepo from "../../repositories/task-outcome.js";
import type { OutcomeSummary } from "../../types/outcome.js";

const outcomes = new Hono();

// POST /tasks/:id/outcome — Tier 3 downstream signal
outcomes.post("/tasks/:id/outcome", async (c) => {
  const taskId = c.req.param("id");
  const body = await c.req.json();

  const parsed = DownstreamOutcomeInput.parse(body);
  const record = await recordDownstreamOutcome(taskId, parsed);

  return c.json(record, 201);
});

// GET /tasks/:id/outcomes — All outcome signals for a task
outcomes.get("/tasks/:id/outcomes", async (c) => {
  const taskId = c.req.param("id");
  const tierParam = c.req.query("tier");

  let records;
  if (tierParam != null) {
    const tier = parseInt(tierParam, 10);
    if (isNaN(tier) || tier < 0 || tier > 3) {
      return c.json({ error: "tier must be an integer 0-3" }, 400);
    }
    records = await outcomeRepo.findByTaskIdAndTier(taskId, tier);
  } else {
    records = await outcomeRepo.findByTaskId(taskId);
  }

  return c.json(records, 200);
});

// GET /tasks/:id/outcomes/summary — Aggregated outcome summary
outcomes.get("/tasks/:id/outcomes/summary", async (c) => {
  const taskId = c.req.param("id");
  const records = await outcomeRepo.findByTaskId(taskId);

  const byTier: Record<
    string,
    {
      total: number;
      positive: number;
      negative: number;
      signals: Array<{
        signal_type: string;
        signal_value: number | null;
        confidence: number | null;
      }>;
    }
  > = {};

  for (const r of records) {
    const key = String(r.tier);
    if (!byTier[key]) {
      byTier[key] = { total: 0, positive: 0, negative: 0, signals: [] };
    }
    byTier[key].total++;
    if (r.signal_value === 1) byTier[key].positive++;
    else byTier[key].negative++;
    byTier[key].signals.push({
      signal_type: r.signal_type,
      signal_value: r.signal_value,
      confidence: r.confidence,
    });
  }

  const summary: OutcomeSummary = {
    task_id: taskId,
    total_signals: records.length,
    positive_signals: records.filter((r) => r.signal_value === 1).length,
    negative_signals: records.filter((r) => r.signal_value === 0).length,
    by_tier: byTier,
  };

  return c.json(summary, 200);
});

export { outcomes };
