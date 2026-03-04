import { formatOutput, type OutputFormat } from "../output.js";

export interface TaskCommandOptions {
  prompt: string;
  tier?: number;
  capabilities?: string[];
  format: OutputFormat;
  baseUrl: string;
}

export async function taskCommand(opts: TaskCommandOptions): Promise<string> {
  const body: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.tier || opts.capabilities) {
    body.metadata = {};
    if (opts.tier) (body.metadata as Record<string, unknown>).tier = opts.tier;
    if (opts.capabilities)
      (body.metadata as Record<string, unknown>).capabilities = opts.capabilities;
  }

  const res = await fetch(`${opts.baseUrl}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok && opts.format !== "json") {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  if (opts.format === "minimal") {
    return `${data.task_id}\t${data.status}\t${data.response_content ?? data.error ?? ""}`;
  }

  // Table format — show key result fields
  const lines = [
    `Task ID:    ${data.task_id}`,
    `Status:     ${data.status}`,
    `Tier:       T${data.complexity_tier ?? "?"}`,
    `Agent:      ${data.selected_agent_id ?? "none"}`,
    `Cost:       ${data.cost_usd != null ? "$" + data.cost_usd.toFixed(4) : "n/a"}`,
    `Latency:    ${data.latency_ms != null ? data.latency_ms + "ms" : "n/a"}`,
  ];

  if (data.response_content) {
    lines.push("", "Response:", data.response_content);
  }
  if (data.error) {
    lines.push("", `Error: ${data.error}`);
  }

  return lines.join("\n");
}
