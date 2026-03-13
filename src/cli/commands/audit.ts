import { formatOutput, type OutputFormat } from "../output.js";

export interface AuditAgentsOptions {
  since?: string;
  format: OutputFormat;
  baseUrl: string;
}

export interface AuditCommitsOptions {
  last?: number;
  format: OutputFormat;
  baseUrl: string;
}

export async function auditAgentsCommand(
  opts: AuditAgentsOptions,
): Promise<string> {
  const since = opts.since ?? "7d";
  const res = await fetch(`${opts.baseUrl}/audit/agents?since=${since}`);
  const data = await res.json();

  if (!res.ok) {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  if (!Array.isArray(data) || data.length === 0) {
    return "(no agent changes)";
  }

  const COLUMNS = ["diff_type", "to_agent_id", "from_status", "to_status"];
  return formatOutput(data, opts.format, COLUMNS);
}

export async function auditCommitsCommand(
  opts: AuditCommitsOptions,
): Promise<string> {
  const limit = opts.last ?? 20;
  const res = await fetch(`${opts.baseUrl}/audit/commits?limit=${limit}`);
  const data = await res.json();

  if (!res.ok) {
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  if (!Array.isArray(data) || data.length === 0) {
    return "(no commits)";
  }

  // Truncate hash for table display
  if (opts.format === "table") {
    for (const row of data) {
      if (typeof row.hash === "string" && row.hash.length > 12) {
        row.hash = row.hash.slice(0, 12);
      }
    }
  }

  const COLUMNS = ["hash", "message", "date", "author"];
  return formatOutput(data, opts.format, COLUMNS);
}
