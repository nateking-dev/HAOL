import { formatOutput, type OutputFormat } from "../output.js";

export interface TaskCommandOptions {
  prompt: string;
  tier?: number;
  capabilities?: string[];
  format: OutputFormat;
  baseUrl: string;
  /**
   * Max time to poll for completion after submission. Defaults to 180s
   * which is above the longest tier-4 LLM timeout. Set to 0 to skip
   * polling and return immediately after the 202.
   */
  waitTimeoutMs?: number;
}

interface TaskBody {
  task_id?: string;
  status?: string;
  done?: boolean;
  response_content?: string | null;
  error?: string | null;
  links?: { self?: string };
  [key: string]: unknown;
}

async function pollTask(baseUrl: string, taskId: string, timeoutMs: number): Promise<TaskBody> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: TaskBody = {};
  let backoffMs = 250;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/tasks/${taskId}`);
    } catch (err) {
      // Network error — surface immediately rather than spinning to deadline.
      return { task_id: taskId, error: `poll request failed: ${(err as Error).message}` };
    }
    // Permanent failures: 4xx (incl. 404 if the row was reaped) and any
    // non-{503,429} 5xx — break out instead of looping silently.
    if (!res.ok && res.status !== 503 && res.status !== 429) {
      let body: TaskBody = {};
      try {
        body = (await res.json()) as TaskBody;
      } catch {
        // non-JSON body — fall through with synthesized error
      }
      return {
        ...body,
        task_id: body.task_id ?? taskId,
        error: body.error ?? `poll failed with HTTP ${res.status}`,
      };
    }
    if (res.ok) {
      lastBody = (await res.json()) as TaskBody;
      if (lastBody.done === true) return lastBody;
      if (lastBody.status === "COMPLETED" || lastBody.status === "FAILED") return lastBody;
    }
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 1.5, 2_000);
  }
  return { ...lastBody, error: lastBody.error ?? "timeout waiting for task to finish" };
}

export async function taskCommand(opts: TaskCommandOptions): Promise<string> {
  const body: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.tier || opts.capabilities) {
    body.metadata = {};
    if (opts.tier) (body.metadata as Record<string, unknown>).tier = opts.tier;
    if (opts.capabilities)
      (body.metadata as Record<string, unknown>).capabilities = opts.capabilities;
  }

  const res = await fetch(`${opts.baseUrl}/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let data = (await res.json()) as TaskBody;

  // Async pipeline: POST returns 202+QUEUED. Poll until terminal so the CLI
  // experience stays synchronous-feeling. If the caller asked for waitTimeoutMs=0
  // they can opt out and just see the QUEUED handle.
  const waitMs = opts.waitTimeoutMs ?? 180_000;
  if (res.ok && res.status === 202 && data.task_id && waitMs > 0) {
    data = await pollTask(opts.baseUrl, data.task_id, waitMs);
  }

  const httpFailed = !res.ok && res.status !== 202;
  if (httpFailed && opts.format !== "json") {
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
    `Tier:       T${(data as { complexity_tier?: number }).complexity_tier ?? "?"}`,
    `Agent:      ${(data as { selected_agent_id?: string }).selected_agent_id ?? "none"}`,
    `Cost:       ${
      (data as { cost_usd?: number }).cost_usd != null
        ? "$" + (data as { cost_usd: number }).cost_usd.toFixed(4)
        : "n/a"
    }`,
    `Latency:    ${
      (data as { latency_ms?: number }).latency_ms != null
        ? (data as { latency_ms: number }).latency_ms + "ms"
        : "n/a"
    }`,
  ];

  if (data.response_content) {
    lines.push("", "Response:", data.response_content);
  }
  if (data.error) {
    lines.push("", `Error: ${data.error}`);
  }

  return lines.join("\n");
}
