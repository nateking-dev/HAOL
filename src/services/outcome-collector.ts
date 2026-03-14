import { uuidv7 } from "../types/task.js";
import * as outcomeRepo from "../repositories/task-outcome.js";
import * as taskLog from "../repositories/task-log.js";
import * as execRepo from "../repositories/execution-log.js";
import { query } from "../db/connection.js";
import { doltCommit } from "../db/dolt.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { TaskOutcomeRecord } from "../types/outcome.js";
import type { ExecutionRecord } from "../types/execution.js";
import type { TaskLogRecord } from "../repositories/task-log.js";
import type { RowDataPacket } from "mysql2/promise";

// --- Tier 0: Structural signals from pipeline data ---

export async function collectStructuralSignals(
  taskId: string,
  execRecords: ExecutionRecord[],
  taskRecord: TaskLogRecord | null,
  constraints?: {
    max_tokens?: number;
    timeout_ms?: number;
    temperature?: number;
  },
): Promise<void> {
  const signals: TaskOutcomeRecord[] = [];

  const makeSignal = (
    signalType: string,
    signalValue: 0 | 1,
    detail?: Record<string, unknown>,
  ): TaskOutcomeRecord => ({
    outcome_id: uuidv7(),
    task_id: taskId,
    tier: 0,
    source: "pipeline",
    signal_type: signalType,
    signal_value: signalValue,
    confidence: taskRecord?.routing_confidence ?? null,
    detail: detail ?? null,
    reported_by: null,
  });

  // Check for fallback activation
  if (taskRecord?.selection_rationale && "fallback_from" in taskRecord.selection_rationale) {
    signals.push(
      makeSignal("fallback_activated", 0, {
        fallback_from: taskRecord.selection_rationale.fallback_from,
      }),
    );
  }

  // Check for errors
  const hasError = execRecords.some((r) => r.outcome === "ERROR");
  if (hasError) {
    signals.push(makeSignal("error_occurred", 0));
  }

  // Check for timeouts
  const hasTimeout = execRecords.some((r) => r.outcome === "TIMEOUT");
  if (hasTimeout) {
    signals.push(makeSignal("timeout_occurred", 0));
  }

  // Check token budget overrun
  if (constraints?.max_tokens) {
    const overrun = execRecords.some((r) => r.output_tokens >= constraints.max_tokens!);
    if (overrun) {
      signals.push(makeSignal("token_budget_overrun", 0));
    }
  }

  // Check cost ceiling breach
  if (taskRecord?.cost_ceiling_usd != null) {
    const totalCost = execRecords.reduce((sum, r) => sum + r.cost_usd, 0);
    if (totalCost > taskRecord.cost_ceiling_usd) {
      signals.push(
        makeSignal("cost_ceiling_breach", 0, {
          ceiling: taskRecord.cost_ceiling_usd,
          actual: totalCost,
        }),
      );
    }
  }

  // Check latency anomaly (3x avg)
  if (execRecords.length > 0) {
    const successRecords = execRecords.filter((r) => r.outcome === "SUCCESS");
    if (successRecords.length > 0) {
      const agentId = successRecords[0].agent_id;
      try {
        const rows = await query<(RowDataPacket & { avg_latency_ms: number })[]>(
          "SELECT avg_latency_ms FROM agent_registry WHERE agent_id = ?",
          [agentId],
        );
        if (rows.length > 0 && rows[0].avg_latency_ms > 0) {
          const anomaly = successRecords.some((r) => r.latency_ms > 3 * rows[0].avg_latency_ms);
          if (anomaly) {
            signals.push(
              makeSignal("latency_anomaly", 0, {
                threshold: 3 * rows[0].avg_latency_ms,
                actual: successRecords[0].latency_ms,
              }),
            );
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  // If no negative signals detected, record a clean execution signal
  if (signals.length === 0) {
    signals.push(makeSignal("clean_execution", 1));
  }

  await outcomeRepo.insertBatch(signals);
}

// --- Tier 1: Format verification ---

export async function runFormatVerification(
  taskId: string,
  responseContent: string,
  formatSpec: {
    type?: string;
    max_length?: number;
    min_length?: number;
    required_fields?: string[];
  },
): Promise<void> {
  const signals: TaskOutcomeRecord[] = [];

  const makeSignal = (
    signalType: string,
    signalValue: 0 | 1,
    detail?: Record<string, unknown>,
  ): TaskOutcomeRecord => ({
    outcome_id: uuidv7(),
    task_id: taskId,
    tier: 1,
    source: "format_check",
    signal_type: signalType,
    signal_value: signalValue,
    confidence: null,
    detail: detail ?? null,
    reported_by: null,
  });

  // JSON validity check
  if (formatSpec.type === "json") {
    try {
      const parsed = JSON.parse(responseContent);
      signals.push(makeSignal("json_valid", 1));

      // Required fields check
      if (formatSpec.required_fields && typeof parsed === "object" && parsed !== null) {
        const missing = formatSpec.required_fields.filter((f) => !(f in parsed));
        if (missing.length === 0) {
          signals.push(makeSignal("required_fields_present", 1));
        } else {
          signals.push(makeSignal("required_fields_present", 0, { missing }));
        }
      }
    } catch {
      signals.push(makeSignal("json_valid", 0));
    }
  }

  // Length bounds check
  if (formatSpec.max_length != null || formatSpec.min_length != null) {
    const len = responseContent.length;
    const withinMax = formatSpec.max_length == null || len <= formatSpec.max_length;
    const withinMin = formatSpec.min_length == null || len >= formatSpec.min_length;
    signals.push(
      makeSignal("length_within_bounds", withinMax && withinMin ? 1 : 0, {
        length: len,
        max_length: formatSpec.max_length ?? null,
        min_length: formatSpec.min_length ?? null,
      }),
    );
  }

  if (signals.length > 0) {
    await outcomeRepo.insertBatch(signals);
  }
}

// --- Tier 2: Routing evaluation sampling ---

const CONFIDENCE_THRESHOLD = 0.6;

export function shouldSampleForEvaluation(confidence: number): boolean {
  return confidence < CONFIDENCE_THRESHOLD;
}

export async function evaluateRoutingDecision(taskId: string): Promise<void> {
  const task = await taskLog.findById(taskId);
  if (!task) return;

  // Insert a pending record so there's an audit trail that evaluation was attempted
  const pendingRecord: TaskOutcomeRecord = {
    outcome_id: uuidv7(),
    task_id: taskId,
    tier: 2,
    source: "routing_eval",
    signal_type: "evaluation_pending",
    signal_value: null,
    confidence: task.routing_confidence,
    detail: {
      complexity_tier: task.complexity_tier,
      routing_layer: task.routing_layer,
    },
    reported_by: null,
  };

  await outcomeRepo.insert(pendingRecord);

  // Perform LLM evaluation via Claude Haiku using the provider abstraction
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return; // Cannot evaluate without API key
    }

    // Gather execution data for this task
    const execRecords = await execRepo.findByTaskId(taskId);
    const successRecord = execRecords.find((r) => r.outcome === "SUCCESS");

    const evalPrompt = buildEvaluationPrompt(task, execRecords, successRecord);
    const provider = new AnthropicProvider("claude-haiku-4-5-20251001");

    const llmResponse = await provider.invoke({
      task_id: taskId,
      prompt: evalPrompt,
      system_prompt:
        "You are a routing quality evaluator for an AI orchestration system. " +
        "Evaluate whether the routing decision was reasonable and respond with a JSON object: " +
        '{"verdict": "YES" or "NO", "reason": "<brief explanation>"}. ' +
        "Respond ONLY with the JSON object, no other text.",
      context: {},
      constraints: {
        max_tokens: 256,
        timeout_ms: 15_000,
        temperature: 0,
      },
    });

    const responseText = llmResponse.content;
    const signalValue = parseEvaluationResponse(responseText);

    // Insert the completed evaluation as a separate record
    const evalRecord: TaskOutcomeRecord = {
      outcome_id: uuidv7(),
      task_id: taskId,
      tier: 2,
      source: "routing_eval",
      signal_type: "evaluation_complete",
      signal_value: signalValue,
      confidence: task.routing_confidence,
      detail: {
        complexity_tier: task.complexity_tier,
        routing_layer: task.routing_layer,
        selected_agent_id: task.selected_agent_id,
        llm_reason: extractReason(responseText),
      },
      reported_by: null,
    };

    await outcomeRepo.insert(evalRecord);
  } catch {
    // Best-effort — LLM evaluation failures must never break the pipeline
  }

  try {
    await doltCommit({
      message: `outcome:tier2:eval | task:${taskId}`,
      author: "haol-outcome <haol@system>",
    });
  } catch {
    // best-effort commit
  }
}

function buildEvaluationPrompt(
  task: TaskLogRecord,
  execRecords: ExecutionRecord[],
  successRecord: ExecutionRecord | undefined,
): string {
  const tierDescriptions: Record<number, string> = {
    1: "T1 (trivial/low-complexity — simple lookups, greetings, factual Q&A)",
    2: "T2 (standard — summarization, translation, moderate analysis)",
    3: "T3 (complex — multi-step reasoning, code generation, creative writing)",
    4: "T4 (expert — research synthesis, architectural design, specialized domains)",
  };

  const tierLabel =
    task.complexity_tier != null
      ? (tierDescriptions[task.complexity_tier] ?? `T${task.complexity_tier} (unknown)`)
      : "unknown";

  const parts: string[] = [
    "Evaluate whether this routing decision was reasonable.\n",
    `## Task Classification`,
    `- Complexity Tier: ${tierLabel}`,
    `- Required Capabilities: ${task.required_capabilities?.join(", ") ?? "none"}`,
    `- Routing Layer: ${task.routing_layer ?? "unknown"}`,
    `- Routing Confidence: ${task.routing_confidence ?? "unknown"}`,
    `- Selected Agent: ${task.selected_agent_id ?? "unknown"}`,
  ];

  if (task.selection_rationale) {
    parts.push(`- Selection Rationale: ${JSON.stringify(task.selection_rationale)}`);
  }

  if (task.cost_ceiling_usd != null) {
    parts.push(`- Cost Ceiling: $${task.cost_ceiling_usd}`);
  }

  // Include execution outcome data
  if (execRecords.length > 0) {
    parts.push(`\n## Execution Results`);
    const totalAttempts = execRecords.length;
    const successCount = execRecords.filter((r) => r.outcome === "SUCCESS").length;
    const errorCount = execRecords.filter((r) => r.outcome === "ERROR").length;
    const timeoutCount = execRecords.filter((r) => r.outcome === "TIMEOUT").length;
    parts.push(`- Total attempts: ${totalAttempts}`);
    parts.push(
      `- Outcomes: ${successCount} success, ${errorCount} errors, ${timeoutCount} timeouts`,
    );

    if (successRecord) {
      parts.push(`- Latency: ${successRecord.latency_ms}ms`);
      parts.push(`- Cost: $${successRecord.cost_usd}`);
      parts.push(`- Tokens: ${successRecord.input_tokens} in / ${successRecord.output_tokens} out`);
    }
  }

  parts.push(
    `\n## Question`,
    `Was assigning this task to tier ${task.complexity_tier ?? "unknown"} with agent "${task.selected_agent_id ?? "unknown"}" a reasonable routing decision? ` +
      `Consider whether the complexity tier matches the required capabilities, and whether the execution outcome suggests the agent was appropriate.`,
  );

  return parts.join("\n");
}

function parseEvaluationResponse(responseText: string): 0 | 1 {
  try {
    const parsed = JSON.parse(responseText) as { verdict?: string };
    if (parsed.verdict && parsed.verdict.toUpperCase().startsWith("YES")) {
      return 1;
    }
    return 0;
  } catch {
    // Fall back to text matching if JSON parsing fails
    const upper = responseText.toUpperCase();
    if (upper.includes('"YES"') || upper.startsWith("YES")) {
      return 1;
    }
    return 0;
  }
}

function extractReason(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}

// --- Tier 3: Downstream outcome ---

export async function recordDownstreamOutcome(
  taskId: string,
  input: {
    signal_type: string;
    signal_value: 0 | 1;
    reported_by: string;
    detail?: Record<string, unknown>;
  },
): Promise<TaskOutcomeRecord> {
  const task = await taskLog.findById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const record: TaskOutcomeRecord = {
    outcome_id: uuidv7(),
    task_id: taskId,
    tier: 3,
    source: "downstream",
    signal_type: input.signal_type,
    signal_value: input.signal_value,
    confidence: task.routing_confidence,
    detail: input.detail ?? null,
    reported_by: input.reported_by,
    created_at: new Date().toISOString(),
  };

  await outcomeRepo.insert(record);

  try {
    await doltCommit({
      message: `outcome:tier3:${input.signal_type} | task:${taskId} | ${input.signal_value ? "positive" : "negative"}`,
      author: "haol-outcome <haol@system>",
    });
  } catch {
    // best-effort commit
  }

  return record;
}
