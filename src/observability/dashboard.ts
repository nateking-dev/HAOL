import {
  costByAgent,
  avgLatencyByAgent,
  failureRate,
  tasksByTier,
  type CostByAgentRow,
  type AvgLatencyRow,
  type FailureRateRow,
  type TasksByTierRow,
} from "./queries.js";

export interface DashboardStats {
  period_hours: number;
  cost: CostByAgentRow[];
  latency: AvgLatencyRow[];
  failures: FailureRateRow[];
  tiers: TasksByTierRow[];
  totals: {
    total_cost: number;
    total_invocations: number;
    total_tasks: number;
    avg_failure_rate: number;
  };
}

export async function getDashboard(hours: number = 24): Promise<DashboardStats> {
  const [cost, latency, failures, tiers] = await Promise.all([
    costByAgent(hours),
    avgLatencyByAgent(hours),
    failureRate(hours),
    tasksByTier(hours),
  ]);

  const totalCost = cost.reduce((sum, r) => sum + r.total_cost, 0);
  const totalInvocations = cost.reduce((sum, r) => sum + r.invocations, 0);
  const totalTasks = tiers.reduce((sum, r) => sum + r.count, 0);

  const totalAll = failures.reduce((sum, r) => sum + r.total, 0);
  const totalFailures = failures.reduce((sum, r) => sum + r.failures, 0);
  const avgFailureRate = totalAll > 0 ? totalFailures / totalAll : 0;

  return {
    period_hours: hours,
    cost,
    latency,
    failures,
    tiers,
    totals: {
      total_cost: totalCost,
      total_invocations: totalInvocations,
      total_tasks: totalTasks,
      avg_failure_rate: avgFailureRate,
    },
  };
}
