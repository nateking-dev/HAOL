import { logger } from "../logging/logger.js";

// Anthropic / OpenAI / Ollama all return error bodies that may echo request
// fragments — including the prompt — in their free-form `message` field.
// That message used to flow through `throw new Error(...)` into
// task_log.worker_error, execution_log.error_detail, and structured logs,
// where Dolt commit history makes it immutable. Capture only the structured
// fields known to be safe (error.type, error.code) for the public message;
// the raw body goes to debug-level logs only.
const RAW_BODY_DEBUG_CAP = 4_000;

interface ParsedError {
  type?: string;
  code?: string;
}

function safeString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickError(parsed: unknown): ParsedError {
  if (typeof parsed !== "object" || parsed === null) return {};
  const root = parsed as { error?: unknown };
  if (typeof root.error !== "object" || root.error === null) return {};
  const err = root.error as { type?: unknown; code?: unknown };
  return { type: safeString(err.type), code: safeString(err.code) };
}

export function formatProviderError(providerName: string, status: number, rawBody: string): string {
  let parsed: ParsedError = {};
  try {
    parsed = pickError(JSON.parse(rawBody));
  } catch {
    // Non-JSON body — debug log only, no detail in public message.
  }

  logger.debug("provider error body", {
    component: "providers",
    provider: providerName,
    status,
    raw_body: rawBody.slice(0, RAW_BODY_DEBUG_CAP),
  });

  const tag = [parsed.type, parsed.code].filter(Boolean).join("/");
  return tag
    ? `${providerName} API error ${status} (${tag})`
    : `${providerName} API error ${status}`;
}
