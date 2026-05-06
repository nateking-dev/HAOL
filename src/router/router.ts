import { classify } from "../classifier/classifier.js";
import { classifyCascade } from "../cascade-router/classify.js";
import { select } from "../services/agent-selection.js";
import { execute } from "../services/execution.js";
import * as taskLog from "../repositories/task-log.js";
import { getActivePolicy } from "../repositories/routing-policy.js";
import { commitSafely } from "../db/dolt.js";
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
  // allowEmpty: true ensures every task gets a Dolt commit for the audit trail,
  // even when the working set is clean (e.g., read-only classification).
  await commitSafely(message, "haol-router <haol@system>", true);
}

// Memory layer is best-effort: a Dolt branching outage must not take down
// task routing. Failures are logged at warn level and the session handle is
// dropped — subsequent memory steps for that task become no-ops.
//
// Each step is bounded by MEMORY_STEP_TIMEOUT_MS, AND total memory work for
// a task is bounded by MEMORY_TASK_BUDGET_MS — once the per-task budget is
// exhausted, remaining steps short-circuit to null without waiting. This
// caps worst-case tail latency for a slow-but-not-failing Dolt cluster: the
// pipeline has up to 5 sequential memory steps, and without a shared budget
// a sick Dolt could otherwise add 5×MEMORY_STEP_TIMEOUT_MS to every task.
//
// Pool-exhaustion guard: when a step's timeout fires, the underlying Dolt
// query keeps its pool connection until the server eventually returns or
// the connection is killed. Under sustained Dolt slowness this would drain
// the entire pool. A process-wide semaphore caps how many pool connections
// memory work can ever monopolize at once — calls past the cap short-
// circuit to null rather than queue, leaving the rest of the pipeline
// (HTTP handlers, classifier, agent selection) with guaranteed connection
// headroom even in the degraded-Dolt case.
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

// Maximum concurrent memory operations across the whole process. Defaults
// to 2 — a tiny fraction of typical pool sizes (DOLT_POOL_SIZE default 5)
// so even a fully-saturated stuck-memory scenario leaves connections free
// for non-memory work. Tune via MEMORY_MAX_CONCURRENT.
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

  // Semaphore: refuse to schedule a new memory operation when the cap is
  // already saturated. We don't queue (which would just shift the latency
  // from "took 5s and timed out" to "waited 5s for a slot then took 5s and
  // timed out"). Memory is best-effort — under contention we'd rather skip
  // the step than back-pressure the task pipeline.
  if (memoryInflight >= memoryMaxConcurrent()) {
    logger.warn("memory step skipped (concurrency cap reached)", {
      component: "router",
      step,
      task_id: taskId,
      inflight: memoryInflight,
      cap: memoryMaxConcurrent(),
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

  // The work promise has to keep running until Dolt eventually returns or
  // the connection is killed — that's the only way the pool connection
  // releases. Decrement memoryInflight when it actually settles, not when
  // Promise.race returns. A dangling .catch swallows late rejections so
  // they don't surface as unhandled-rejection warnings after the race has
  // already resolved via timeoutPromise.
  const work = fn();
  work
    .finally(() => {
      memoryInflight--;
    })
    .catch(() => {
      // Already observed by the race below (or intentionally ignored if the
      // timeout won). Swallow to avoid unhandledRejection.
    });

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

/** Test hook — exposes the internal helper without changing its access shape. */
export const _bestEffortMemoryForTests = bestEffortMemory;
export const _createMemoryBudgetForTests = createMemoryBudget;

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
  excludeAgentId: string,
  policy?: RoutingPolicy,
): Promise<{ agent_id: string } | null> {
  try {
    const result = await select(classification, policy);
    // If the same agent is selected, no point retrying
    if (result.selected_agent_id === excludeAgentId) {
      // Try the second-best if available
      const secondBest = result.scored_candidates.find((c) => c.agent_id !== excludeAgentId);
      return secondBest ? { agent_id: secondBest.agent_id } : null;
    }
    return { agent_id: result.selected_agent_id };
  } catch {
    return null;
  }
}
