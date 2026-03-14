import { classify } from "../classifier/classifier.js";
import { classifyCascade } from "../cascade-router/classify.js";
import { select } from "../services/agent-selection.js";
import { execute } from "../services/execution.js";
import * as taskLog from "../repositories/task-log.js";
import { getActivePolicy } from "../repositories/routing-policy.js";
import { doltCommit } from "../db/dolt.js";
import type { AgentRequest, ExecutionRecord } from "../types/execution.js";
import type { ComplexityTier, TaskClassification } from "../types/task.js";
import { uuidv7 } from "../types/task.js";
import type { RoutingPolicy } from "../types/selection.js";
import * as execRepo from "../repositories/execution-log.js";
import type { RouterTaskInput, TaskResult } from "../types/router.js";
import { RouterTaskInput as RouterTaskInputSchema } from "../types/router.js";
import {
  collectStructuralSignals,
  runFormatVerification,
  shouldSampleForEvaluation,
  evaluateRoutingDecision,
} from "../services/outcome-collector.js";
import { loadConfig } from "../cascade-router/reference-store.js";

export const DEFAULT_TIMEOUT_MS: Record<ComplexityTier, number> = {
  1: 15_000,
  2: 30_000,
  3: 60_000,
  4: 120_000,
};

async function commitSafely(message: string): Promise<void> {
  try {
    await doltCommit({ message, author: "haol-router <haol@system>", allowEmpty: true });
  } catch (err) {
    if (!(err as Error).message?.includes("nothing to commit")) {
      throw err;
    }
  }
}

export async function routeTask(input: RouterTaskInput): Promise<TaskResult> {
  const parsed = RouterTaskInputSchema.parse(input);

  let taskId: string | null = null;
  let status: TaskResult["status"] = "RECEIVED";

  try {
    // 1. Classify — try cascade router, fall back to old classifier
    let classification: TaskClassification;
    try {
      classification = await classifyCascade({
        prompt: parsed.prompt,
        metadata: parsed.metadata,
      });
    } catch {
      classification = classify({
        prompt: parsed.prompt,
        metadata: parsed.metadata,
      });
    }
    taskId = classification.task_id;

    // 2. Intake — write to task_log
    await taskLog.create(taskId, classification.prompt_hash);
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

    // 4. Select agent
    const policy = await getActivePolicy();
    const selection = await select(classification, policy ?? undefined);

    await taskLog.updateSelection(taskId, selection.selected_agent_id, selection.rationale);
    status = "DISPATCHED";

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

    // 7. Update final status
    if (execResult.outcome === "SUCCESS") {
      await taskLog.updateStatus(taskId, "COMPLETED");
      status = "COMPLETED";
    } else {
      await taskLog.updateStatus(taskId, "FAILED");
      status = "FAILED";
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
        shouldSampleForEvaluation(classification.routing_confidence, routerConfig.confidence_threshold)
      ) {
        evaluateRoutingDecision(taskId).catch(() => {});
      }
    } catch {
      // best-effort — never fail the task due to outcome collection
    }

    // 8. Commit
    const costStr = execResult.cost_usd > 0 ? `$${execResult.cost_usd.toFixed(4)}` : "$0";
    await commitSafely(
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
    };
  } catch (err) {
    // On any error, mark as failed and still commit
    if (taskId) {
      try {
        await taskLog.updateStatus(taskId, "FAILED");
      } catch {
        // best-effort status update
      }
      try {
        await commitSafely(`task:${taskId} | FAILED | ${(err as Error).message}`);
      } catch {
        // best-effort commit
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
