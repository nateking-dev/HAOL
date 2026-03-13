import { formatOutput, type OutputFormat } from "../output.js";

export interface AgentsListOptions {
  status?: string;
  format: OutputFormat;
  baseUrl: string;
}

export interface AgentsUpdateOptions {
  agentId: string;
  status?: string;
  format: OutputFormat;
  baseUrl: string;
}

const AGENT_COLUMNS = [
  "agent_id",
  "provider",
  "model_id",
  "status",
  "tier_ceiling",
  "capabilities",
  "avg_latency_ms",
];

export async function agentsListCommand(
  opts: AgentsListOptions,
): Promise<string> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  const url = `${opts.baseUrl}/agents${qs ? "?" + qs : ""}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok && opts.format !== "json") {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  // Truncate capabilities for table display
  if (opts.format === "table" && Array.isArray(data)) {
    for (const agent of data) {
      if (Array.isArray(agent.capabilities)) {
        agent.capabilities = agent.capabilities.join(",");
      }
    }
  }

  return formatOutput(data, opts.format, AGENT_COLUMNS);
}

export async function agentsUpdateCommand(
  opts: AgentsUpdateOptions,
): Promise<string> {
  const body: Record<string, unknown> = {};
  if (opts.status) body.status = opts.status;

  const res = await fetch(`${opts.baseUrl}/agents/${opts.agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok && opts.format !== "json") {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") return formatOutput(data, "json");
  return `Agent ${opts.agentId} updated.`;
}

export async function agentsRemoveCommand(
  agentId: string,
  baseUrl: string,
  format: OutputFormat,
): Promise<string> {
  const res = await fetch(`${baseUrl}/agents/${agentId}`, {
    method: "DELETE",
  });

  const data = await res.json();

  if (!res.ok && format !== "json") {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (format === "json") return formatOutput(data, "json");
  return `Agent ${agentId} disabled.`;
}
