import { logger } from "../logging/logger.js";

// Raw body is debug-only — anything above debug persists into task_log /
// execution_log / Dolt history and may carry prompt fragments.
const RAW_BODY_DEBUG_CAP = 4_000;
// Cap on each extracted tag (type/code). Defends against an upstream that
// stuffs prompt fragments into a normally-short field.
const MAX_TAG_LEN = 64;

interface ParsedError {
  type?: string;
  code?: string;
}

function safeString(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, MAX_TAG_LEN) : undefined;
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
