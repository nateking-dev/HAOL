import { formatOutput, type OutputFormat } from "../output.js";

export interface TuneCommandOptions {
  hours?: number;
  dryRun: boolean;
  format: OutputFormat;
  baseUrl: string;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return { error: `Non-JSON response (${res.status})` };
  }
}

export async function tuneCommand(opts: TuneCommandOptions): Promise<string> {
  const hours = opts.hours ?? 72;
  const dryRun = opts.dryRun ? "&dry_run=true" : "";
  const res = await fetch(`${opts.baseUrl}/observability/tune?hours=${hours}${dryRun}`, {
    method: "POST",
  });
  const data = await safeJson(res);

  if (!res.ok) {
    return `Error (${res.status}): ${(data as { error?: string }).error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  const d = data as Record<string, unknown>;
  const agentTierOutcomes = (d.agent_tier_outcomes ?? []) as Record<string, unknown>[];
  const rulesCreated = (d.rules_created ?? []) as Record<string, unknown>[];
  const utterancesAdded = (d.utterances_added ?? []) as Record<string, unknown>[];

  const lines: string[] = [
    `=== Tuning ${d.status === "dry_run" ? "(dry run) " : ""}Complete ===`,
    "",
    `Run ID:              ${d.run_id}`,
    `Window:              ${d.hours_window}h`,
    `Tasks analyzed:      ${d.tasks_analyzed}`,
    `Signals used:        ${d.signals_used}`,
    `Rules crystallized:  ${rulesCreated.length}`,
    `Utterances promoted: ${utterancesAdded.length}`,
    `Actionable combos:   ${d.actionable_agent_tier_combos} agent+tier pairs with sufficient data`,
  ];

  if (agentTierOutcomes.length > 0) {
    lines.push("", "Agent Performance by Tier:");
    for (const o of agentTierOutcomes) {
      const rate = (Number(o.success_rate) * 100).toFixed(1);
      lines.push(
        `  ${String(o.agent_id).padEnd(28)} T${o.complexity_tier}  ${rate}% success  (${o.positive}/${o.total})`,
      );
    }
  }

  if (rulesCreated.length > 0) {
    lines.push("", "Crystallized Rules:");
    for (const r of rulesCreated) {
      lines.push(`  T${r.tier_id} contains "${r.pattern}" (from ${r.source_task_count} tasks)`);
    }
  }

  if (utterancesAdded.length > 0) {
    lines.push("", "Promoted Utterances:");
    for (const u of utterancesAdded) {
      const text =
        String(u.utterance_text).length > 60
          ? String(u.utterance_text).slice(0, 57) + "..."
          : String(u.utterance_text);
      lines.push(`  T${u.tier_id} "${text}"`);
    }
  }

  return lines.join("\n");
}

export interface TuneHistoryCommandOptions {
  last?: number;
  format: OutputFormat;
  baseUrl: string;
}

export async function tuneHistoryCommand(opts: TuneHistoryCommandOptions): Promise<string> {
  const limit = opts.last ?? 10;
  const res = await fetch(`${opts.baseUrl}/observability/tune/history?limit=${limit}`);
  const data = await safeJson(res);

  if (!res.ok) {
    return `Error (${res.status}): ${(data as { error?: string }).error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  return formatOutput(data, "table", [
    "run_id",
    "status",
    "started_at",
    "tasks_analyzed",
    "rules_created",
    "utterances_added",
  ]);
}
