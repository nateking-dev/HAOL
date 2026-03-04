import { formatOutput, type OutputFormat } from "../output.js";

export interface HistoryCommandOptions {
  last?: number;
  agent?: string;
  format: OutputFormat;
  baseUrl: string;
}

export async function historyCommand(opts: HistoryCommandOptions): Promise<string> {
  // Fetch recent tasks — the API doesn't have a dedicated history endpoint yet,
  // so we use the agents endpoint to at least show task-related info.
  // For MVP, query dolt_log for recent commits that contain task info.
  const params = new URLSearchParams();
  if (opts.last) params.set("limit", String(opts.last));
  if (opts.agent) params.set("agent", opts.agent);
  const qs = params.toString();

  const res = await fetch(`${opts.baseUrl}/audit/commits${qs ? "?" + qs : ""}`);

  if (!res.ok) {
    // Fallback: audit endpoint may not exist yet (Story 10)
    if (res.status === 404) {
      return "History endpoint not available. Implement Story 10 (Observability) for full history support.";
    }
    const data = await res.json();
    return `Error (${res.status}): ${data.error ?? "Unknown error"}`;
  }

  const data = await res.json();

  if (opts.format === "json") {
    return formatOutput(data, "json");
  }

  if (!Array.isArray(data) || data.length === 0) {
    return "(no history)";
  }

  // Filter by agent if needed (client-side since server may not support it)
  let filtered = data;
  if (opts.agent) {
    filtered = data.filter(
      (entry: Record<string, unknown>) =>
        String(entry.message ?? "").includes(opts.agent!),
    );
  }

  // Limit
  if (opts.last && filtered.length > opts.last) {
    filtered = filtered.slice(0, opts.last);
  }

  const COLUMNS = ["hash", "message", "date"];
  if (opts.format === "table") {
    // Truncate hash for display
    for (const row of filtered) {
      if (typeof row.hash === "string" && row.hash.length > 12) {
        row.hash = row.hash.slice(0, 12);
      }
    }
  }

  return formatOutput(filtered, opts.format, COLUMNS);
}
