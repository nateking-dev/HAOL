import { formatOutput, type OutputFormat } from "../output.js";

export interface TuneCommandOptions {
  hours?: number;
  dryRun: boolean;
  format: OutputFormat;
  baseUrl: string;
}

export async function tuneCommand(opts: TuneCommandOptions): Promise<string> {
  const hours = opts.hours ?? 72;
  const dryRun = opts.dryRun ? "&dry_run=true" : "";
  const res = await fetch(`${opts.baseUrl}/observability/tune?hours=${hours}${dryRun}`, {
    method: "POST",
  });
  const data = await res.json();

  if (!res.ok) {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  const lines: string[] = [
    `=== Tuning ${data.status === "dry_run" ? "(dry run) " : ""}Complete ===`,
    "",
    `Run ID:              ${data.run_id}`,
    `Window:              ${data.hours_window}h`,
    `Tasks analyzed:      ${data.tasks_analyzed}`,
    `Signals used:        ${data.signals_used}`,
    `Rules crystallized:  ${data.rules_created.length}`,
    `Utterances promoted: ${data.utterances_added.length}`,
    `Actionable combos:   ${data.actionable_agent_tier_combos} agent+tier pairs with sufficient data`,
  ];

  if (data.agent_tier_outcomes.length > 0) {
    lines.push("", "Agent Performance by Tier:");
    for (const o of data.agent_tier_outcomes) {
      const rate = (o.success_rate * 100).toFixed(1);
      lines.push(
        `  ${o.agent_id.padEnd(28)} T${o.complexity_tier}  ${rate}% success  (${o.positive}/${o.total})`,
      );
    }
  }

  if (data.rules_created.length > 0) {
    lines.push("", "Crystallized Rules:");
    for (const r of data.rules_created) {
      lines.push(`  T${r.tier_id} contains "${r.pattern}" (from ${r.source_task_count} tasks)`);
    }
  }

  if (data.utterances_added.length > 0) {
    lines.push("", "Promoted Utterances:");
    for (const u of data.utterances_added) {
      const text =
        u.utterance_text.length > 60 ? u.utterance_text.slice(0, 57) + "..." : u.utterance_text;
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
  const data = await res.json();

  if (!res.ok) {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
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
