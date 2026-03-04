import { formatOutput, type OutputFormat } from "../output.js";

export interface StatusCommandOptions {
  taskId: string;
  format: OutputFormat;
  baseUrl: string;
}

export async function statusCommand(opts: StatusCommandOptions): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/tasks/${opts.taskId}`);
  const data = await res.json();

  if (!res.ok && opts.format !== "json") {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  if (opts.format === "minimal") {
    return `${data.task_id}\t${data.status}`;
  }

  // Detailed status view
  const lines = [
    `Task ID:       ${data.task_id}`,
    `Status:        ${data.status}`,
    `Created:       ${data.created_at}`,
    `Tier:          T${data.complexity_tier ?? "?"}`,
    `Capabilities:  ${data.required_capabilities?.join(", ") ?? "n/a"}`,
    `Cost Ceiling:  ${data.cost_ceiling_usd != null ? "$" + data.cost_ceiling_usd : "n/a"}`,
    `Agent:         ${data.selected_agent_id ?? "none"}`,
  ];

  if (data.executions && data.executions.length > 0) {
    lines.push("", "Executions:");
    for (const exec of data.executions) {
      lines.push(
        `  #${exec.attempt_number} ${exec.outcome} | ${exec.agent_id} | ` +
          `${exec.latency_ms}ms | $${exec.cost_usd?.toFixed(4) ?? "0"} | ` +
          `${exec.input_tokens}in/${exec.output_tokens}out`,
      );
    }
  }

  return lines.join("\n");
}
