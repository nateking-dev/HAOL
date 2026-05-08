import { classify } from "../classifier/classifier.js";
import { classifyCascade } from "../cascade-router/classify.js";
import { select } from "../services/agent-selection.js";
import { execute } from "../services/execution.js";
import * as taskLog from "../repositories/task-log.js";
import { getActivePolicy } from "../repositories/routing-policy.js";
import { commitSafely } from "../db/dolt.js";
import { costCeilingForTier } from "../classifier/scoring.js";
import type { AgentRequest, ExecutionRecord } from "../types/execution.js";
import type { ComplexityTier, TaskClassification } from "../types/task.js";
import { uuidv7 } from "../types/task.js";
import type { RoutingPolicy } from "../types/selection.js";
import * as execRepo from "../repositories/execution-log.js";
import type { RouterTaskInput, TaskResult } from "../types/router.js";
import type { SelectionResult } from "../types/selection.js";
import { RouterTaskInput as RouterTaskInputSchema } from "../types/router.js";
import {
  collectStructuralSignals,
  runFormatVerification,
  shouldSampleForEvaluation,
  evaluateRoutingDecision,
} from "../services/outcome-collector.js";
import { loadConfig } from "../cascade-router/reference-store.js";
import type { CascadeTrace } from "../cascade-router/types.js";
import { logger } from "../logging/logger.js";
import {
  createSession,
  writeContext,
  commitSession,
  discardSession,
  type SessionHandle,
} from "../memory/session-manager.js";

export const DEFAULT_TIMEOUT_MS: Record<ComplexityTier, number> = {
  1: 15_000,
  2: 30_000,
  3: 60_000,
  4: 120_000,
};

async function routerCommit(message: string): Promise<void> {
  // No allowEmpty: a task with no row changes (read-only classification,
  // pipeline aborted before any write) shouldn't add a commit-message-only
  // entry to dolt_log. commitSafely silently swallows "nothing to commit".
  await commitSafely(message, "haol-router <haol@system>");
}

// Memory layer is best-effort: each step is bounded by MEMORY_STEP_TIMEOUT_MS,
// total per-task work by MEMORY_TASK_BUDGET_MS, and concurrent in-flight ops
// across the process by MEMORY_MAX_CONCURRENT (semaphore guards pool exhaustion).
function memoryStepTimeoutMs(): number {
  const raw = process.env.MEMORY_STEP_TIMEOUT_MS;
  if (!raw) return 5_000;
  const ms = parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 100 ? ms : 5_000;
}

function memoryTaskBudgetMs(): number {
  const raw = process.env.MEMORY_TASK_BUDGET_MS;
  if (!raw) return 8_000;
  const ms = parseInt(raw, 10);
  return Number.isFinite(ms) && ms >= 100 ? ms : 8_000;
}

// Default 2; should stay well below DOLT_POOL_SIZE so non-memory work always
// has connection headroom even when memory is saturated on a degraded Dolt.
function memoryMaxConcurrent(): number {
  const raw = process.env.MEMORY_MAX_CONCURRENT;
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

let memoryInflight = 0;

interface MemoryBudget {
  startedAt: number;
  totalMs: number;
}

function createMemoryBudget(): MemoryBudget {
  return { startedAt: Date.now(), totalMs: memoryTaskBudgetMs() };
}

function remainingBudgetMs(budget: MemoryBudget): number {
  return Math.max(0, budget.totalMs - (Date.now() - budget.startedAt));
}

async function bestEffortMemory<T>(
  step: string,
  taskId: string,
  budget: MemoryBudget,
  fn: () => Promise<T>,
): Promise<T | null> {
  const remaining = remainingBudgetMs(budget);
  if (remaining === 0) {
    logger.warn("memory step skipped (task budget exhausted)", {
      component: "router",
      step,
      task_id: taskId,
    });
    return null;
  }

  // Short-circuit rather than queue: queuing just shifts a 5s timeout to
  // 10s wait + 5s timeout under sustained Dolt slowness.
  const cap = memoryMaxConcurrent();
  if (memoryInflight >= cap) {
    logger.warn("memory step skipped (concurrency cap reached)", {
      component: "router",
      step,
      task_id: taskId,
      inflight: memoryInflight,
      cap,
    });
    return null;
  }

  memoryInflight++;
  const timeoutMs = Math.min(memoryStepTimeoutMs(), remaining);
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`memory ${step} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  // Slot releases when fn() actually settles, not when the race returns,
  // so a timed-out step still holds its slot until Dolt frees the conn.
  // The dangling .catch swallows late rejections to avoid unhandledRejection.
  // Math.max(0, ...) guards against undershoot if a test reset the counter
  // while this promise was still pending.
  const work = fn();
  work.finally(() => (memoryInflight = Math.max(0, memoryInflight - 1))).catch(() => {});

  try {
    return await Promise.race([work, timeoutPromise]);
  } catch (err) {
    logger.warn("memory step failed", {
      component: "router",
      step,
      task_id: taskId,
      error: (err as Error).message,
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test/observability hook. */
export function _memoryInflightForTests(): number {
  return memoryInflight;
}

/** Test hook — zero the counter so a leaked promise from one test can't poison the next. */
export function _resetMemoryInflightForTests(): void {
  memoryInflight = 0;
}

export const _bestEffortMemoryForTests = bestEffortMemory;
export const _createMemoryBudgetForTests = createMemoryBudget;
export const _tryFallbackAgentForTests = tryFallbackAgent;

export interface RouteTaskOptions {
  /**
   * Pre-allocated task_id from the async intake path. When provided, the
   * caller has already inserted a row in task_log (typically QUEUED) and
   * routeTask will reuse this id throughout — including in classifier
   * decision logs — and skip the INSERT.
   */
  taskId?: string;
}

export async function routeTask(
  input: RouterTaskInput,
  options: RouteTaskOptions = {},
): Promise<TaskResult> {
  const parsed = RouterTaskInputSchema.parse(input);
  const preAllocated = options.taskId;

  let taskId: string | null = preAllocated ?? null;
  let status: TaskResult["status"] = "RECEIVED";
  let cascadeTrace: CascadeTrace | undefined;
  let selectionResult: SelectionResult | undefined;
  let session: SessionHandle | null = null;
  const memoryBudget = createMemoryBudget();

  try {
    // 1. Classify — try cascade router, fall back to old classifier
    let classification: TaskClassification;
    try {
      classification = await classifyCascade(
        {
          prompt: parsed.prompt,
          metadata: parsed.metadata,
        },
        preAllocated,
      );
    } catch {
      classification = classify(
        {
          prompt: parsed.prompt,
          metadata: parsed.metadata,
        },
        preAllocated,
      );
    }
    taskId = classification.task_id;
    cascadeTrace = classification.cascade_trace;

    // 2. Intake — write to task_log unless caller pre-inserted the row
    // (async path inserts in QUEUED status before the worker picks it up).
    if (!preAllocated) {
      await taskLog.create(taskId, classification.prompt_hash);
    }
    status = "RECEIVED";

    // Store routing confidence on task_log (after create so the row exists)
    if (classification.routing_confidence != null) {
      await taskLog.updateRoutingConfidence(
        taskId,
        classification.routing_confidence,
        classification.routing_layer,
      );
    }

    // Store expected format if provided
    if (parsed.expected_format) {
      await taskLog.updateExpectedFormat(taskId, parsed.expected_format);
    }

    // 3. Update classification
    await taskLog.updateClassification(
      taskId,
      classification.complexity_tier,
      classification.required_capabilities,
      classification.cost_ceiling_usd,
    );
    status = "CLASSIFIED";

    // 3b. Open per-task memory branch. Failures here drop the handle so all
    // subsequent memory writes/commits become no-ops, but task execution
    // proceeds normally.
    // Capture taskId into a non-null const so the lambdas below don't need
    // taskId! — TypeScript can't carry the reassignment narrowing of the
    // outer `let taskId: string | null` across closure boundaries.
    const tid = taskId;
    session = await bestEffortMemory("createSession", tid, memoryBudget, () => createSession(tid));
    if (session) {
      const handle = session;
      await bestEffortMemory("writeContext:classification", tid, memoryBudget, () =>
        writeContext(handle, "classification", classification),
      );
    }

    // 4. Select agent
    const policy = await getActivePolicy();
    const selection = await select(classification, policy ?? undefined);
    selectionResult = selection;

    await taskLog.updateSelection(taskId, selection.selected_agent_id, selection.rationale);
    status = "DISPATCHED";

    if (session) {
      const handle = session;
      await bestEffortMemory("writeContext:selection", tid, memoryBudget, () =>
        writeContext(handle, "selection", selection),
      );
    }

    // 5. Execute
    const agentRequest: AgentRequest = {
      task_id: taskId,
      prompt: parsed.prompt,
      system_prompt: undefined,
      context: {},
      constraints: {
        max_tokens: parsed.constraints?.max_tokens ?? 4096,
        timeout_ms:
          parsed.constraints?.timeout_ms ?? DEFAULT_TIMEOUT_MS[classification.complexity_tier],
        temperature: parsed.constraints?.temperature,
      },
    };

    const maxRetries = policy?.max_retries ?? 2;
    const allExecRecords: ExecutionRecord[] = [];
    let execResult = await execute(selection.selected_agent_id, agentRequest, maxRetries);
    allExecRecords.push(execResult);

    // 6. Handle fallback on execution failure
    if (execResult.outcome !== "SUCCESS" && policy?.fallback_strategy !== "ABORT") {
      // Try next-best agent if available
      const fallbackSelection = await tryFallbackAgent(
        classification,
        selection,
        selection.selected_agent_id,
        policy ?? undefined,
      );

      if (fallbackSelection) {
        await taskLog.updateSelection(taskId, fallbackSelection.agent_id, {
          fallback_from: selection.selected_agent_id,
          reason: execResult.outcome,
        });

        try {
          execResult = await execute(
            fallbackSelection.agent_id,
            agentRequest,
            0, // no retries on fallback
          );
          allExecRecords.push(execResult);
        } catch (fallbackErr) {
          // Fallback execution threw — insert a synthetic error record
          // so collectStructuralSignals can see the failed attempt.
          const syntheticRecord: ExecutionRecord = {
            execution_id: uuidv7(),
            task_id: taskId,
            agent_id: fallbackSelection.agent_id,
            attempt_number: allExecRecords.length + 1,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            latency_ms: 0,
            ttft_ms: 0,
            outcome: "ERROR",
            error_detail: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
            response_content: null,
          };
          await execRepo.insertExecution(syntheticRecord);
          allExecRecords.push(syntheticRecord);
          // execResult stays as the original failure — proceed with it
        }
      }
    }

    // 7. Atomic terminal-state write — async pollers must never see
    // status=COMPLETED with response_content=null between two writes.
    if (execResult.outcome === "SUCCESS") {
      await taskLog.markCompleted(taskId, execResult.response_content);
      status = "COMPLETED";
    } else {
      // Surface the underlying execution error_detail to worker_error so a
      // poller hitting GET /tasks/:id can see the failure cause without
      // having to dig into the executions array.
      await taskLog.markFailed(taskId, execResult.error_detail);
      status = "FAILED";
    }

    // 7a. Memory finalization. On SUCCESS we merge the session branch into
    // main and delete it; on FAILED we keep the branch around for forensics —
    // pruneSessionBranches eventually reclaims it based on retention.
    if (session) {
      const handle = session;
      await bestEffortMemory("writeContext:execution", tid, memoryBudget, () =>
        writeContext(handle, "execution", { records: allExecRecords, final: execResult }),
      );
      if (execResult.outcome === "SUCCESS") {
        await bestEffortMemory("commitSession", tid, memoryBudget, () => commitSession(handle));
      } else {
        await bestEffortMemory("discardSession", tid, memoryBudget, () => discardSession(handle));
      }
      session = null;
    }

    // 7b. Best-effort outcome collection
    try {
      const taskRecord = await taskLog.findById(taskId);
      await collectStructuralSignals(taskId, allExecRecords, taskRecord, agentRequest.constraints);

      if (parsed.expected_format && execResult.response_content) {
        await runFormatVerification(taskId, execResult.response_content, parsed.expected_format);
      }

      const routerConfig = await loadConfig();
      if (
        classification.routing_confidence != null &&
        shouldSampleForEvaluation(
          classification.routing_confidence,
          routerConfig.confidence_threshold,
        )
      ) {
        evaluateRoutingDecision(taskId).catch(() => {});
      }
    } catch (outcomeErr) {
      // best-effort — never fail the task due to outcome collection
      logger.warn("outcome collection failed", {
        component: "router",
        error: (outcomeErr as Error).message,
      });
    }

    // 8. Commit
    const costStr = execResult.cost_usd > 0 ? `$${execResult.cost_usd.toFixed(4)}` : "$0";
    await routerCommit(
      `task:${taskId} | tier:T${classification.complexity_tier} | agent:${execResult.agent_id} | cost:${costStr} | ${execResult.latency_ms}ms`,
    );

    return {
      task_id: taskId,
      status,
      complexity_tier: classification.complexity_tier,
      selected_agent_id: execResult.agent_id,
      response_content: execResult.response_content,
      cost_usd: execResult.cost_usd,
      latency_ms: execResult.latency_ms,
      error: execResult.error_detail,
      cascade_trace: cascadeTrace,
      selection_detail: selectionResult
        ? {
            scored_candidates: selectionResult.scored_candidates,
            policy_weights: {
              capability: policy?.weight_capability ?? 0.5,
              cost: policy?.weight_cost ?? 0.3,
              latency: policy?.weight_latency ?? 0.2,
            },
            fallback_applied: selectionResult.fallback_applied,
          }
        : undefined,
    };
  } catch (err) {
    // On any unhandled error (classify failure, no agents, DB outage),
    // surface the message to worker_error so callers polling GET /tasks/:id
    // can distinguish this from a worker-level crash.
    if (taskId) {
      try {
        await taskLog.markFailed(taskId, (err as Error).message);
      } catch {
        // best-effort status update
      }
      try {
        await routerCommit(`task:${taskId} | FAILED | ${(err as Error).message}`);
      } catch {
        // best-effort commit
      }
      if (session) {
        // Discard (no-op preserve) so the failed-task branch remains for
        // forensics; pruneSessionBranches reclaims it on retention expiry.
        const handle = session;
        await bestEffortMemory("discardSession", taskId, memoryBudget, () =>
          discardSession(handle),
        );
      }
    }

    return {
      task_id: taskId ?? "unknown",
      status: "FAILED",
      complexity_tier: null,
      selected_agent_id: null,
      response_content: null,
      cost_usd: null,
      latency_ms: null,
      error: (err as Error).message,
      cascade_trace: cascadeTrace,
      selection_detail: selectionResult
        ? {
            scored_candidates: selectionResult.scored_candidates,
            policy_weights: {
              capability: 0.5,
              cost: 0.3,
              latency: 0.2,
            },
            fallback_applied: selectionResult.fallback_applied,
          }
        : undefined,
    };
  }
}

async function tryFallbackAgent(
  classification: TaskClassification,
  selection: SelectionResult,
  excludeAgentId: string,
  policy?: RoutingPolicy,
): Promise<{ agent_id: string } | null> {
  // ABORT is filtered at the call site, but enforce it at the function
  // boundary too so the contract doesn't depend on an invisible precondition.
  if (policy?.fallback_strategy === "ABORT") return null;

  if (policy?.fallback_strategy === "TIER_UP") {
    // At T4 there's no higher tier — TIER_UP semantics can't apply.
    if (classification.complexity_tier >= 4) {
      logger.warn("TIER_UP requested but task already at top tier; falling through to NEXT_BEST", {
        component: "router",
        task_id: classification.task_id,
        from_tier: classification.complexity_tier,
        to_tier: null,
      });
    } else {
      // Re-rank against the next-higher tier with its higher cost ceiling.
      // This is a different candidate set than the original ranking, so we
      // have to call select() again.
      const higherTier = (classification.complexity_tier + 1) as ComplexityTier;
      const escalated: TaskClassification = {
        ...classification,
        complexity_tier: higherTier,
        cost_ceiling_usd: costCeilingForTier(higherTier),
      };
      try {
        const result = await select(escalated, policy);
        if (result.selected_agent_id !== excludeAgentId) {
          logger.info("TIER_UP escalation succeeded", {
            component: "router",
            task_id: classification.task_id,
            from_tier: classification.complexity_tier,
            to_tier: higherTier,
            agent_id: result.selected_agent_id,
          });
          return { agent_id: result.selected_agent_id };
        }
        const next = result.scored_candidates.find((c) => c.agent_id !== excludeAgentId);
        if (next) {
          logger.info("TIER_UP escalation succeeded (second-best at higher tier)", {
            component: "router",
            task_id: classification.task_id,
            from_tier: classification.complexity_tier,
            to_tier: higherTier,
            agent_id: next.agent_id,
          });
          return { agent_id: next.agent_id };
        }
        logger.warn(
          "TIER_UP escalation returned no new agent; using NEXT_BEST from original tier",
          {
            component: "router",
            task_id: classification.task_id,
            from_tier: classification.complexity_tier,
            to_tier: higherTier,
          },
        );
      } catch (err) {
        logger.warn("TIER_UP escalation failed; falling through to NEXT_BEST", {
          component: "router",
          task_id: classification.task_id,
          from_tier: classification.complexity_tier,
          to_tier: higherTier,
          error: (err as Error).message,
        });
      }
    }
  }

  // NEXT_BEST (and TIER_UP fall-through): consume the already-ranked candidates
  // from the original selection. No DB round-trip.
  const next = selection.scored_candidates.find((c) => c.agent_id !== excludeAgentId);
  return next ? { agent_id: next.agent_id } : null;
}
