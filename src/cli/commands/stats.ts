import { formatOutput, type OutputFormat } from "../output.js";

export interface StatsCommandOptions {
  hours?: number;
  format: OutputFormat;
  baseUrl: string;
}

export async function statsCommand(opts: StatsCommandOptions): Promise<string> {
  const hours = opts.hours ?? 24;
  const res = await fetch(`${opts.baseUrl}/stats?hours=${hours}`);
  const data = await res.json();

  if (!res.ok) {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  // Dashboard summary
  const lines: string[] = [
    `=== HAOL Dashboard (last ${data.period_hours}h) ===`,
    "",
    `Total Cost:        $${data.totals.total_cost.toFixed(4)}`,
    `Total Invocations: ${data.totals.total_invocations}`,
    `Total Tasks:       ${data.totals.total_tasks}`,
    `Avg Failure Rate:  ${(data.totals.avg_failure_rate * 100).toFixed(1)}%`,
  ];

  if (data.cost.length > 0) {
    lines.push("", "Cost by Agent:");
    for (const r of data.cost) {
      lines.push(`  ${r.agent_id.padEnd(30)} $${r.total_cost.toFixed(4)} (${r.invocations} calls)`);
    }
  }

  if (data.latency.length > 0) {
    lines.push("", "Avg Latency by Agent:");
    for (const r of data.latency) {
      lines.push(`  ${r.agent_id.padEnd(30)} ${Math.round(r.avg_latency_ms)}ms`);
    }
  }

  if (data.failures.length > 0) {
    lines.push("", "Failure Rates:");
    for (const r of data.failures) {
      lines.push(
        `  ${r.agent_id.padEnd(30)} ${r.failures}/${r.total} (${(r.rate * 100).toFixed(1)}%)`,
      );
    }
  }

  if (data.tiers.length > 0) {
    lines.push("", "Tasks by Tier:");
    for (const r of data.tiers) {
      lines.push(`  T${r.tier}: ${r.count}`);
    }
  }

  return lines.join("\n");
}
