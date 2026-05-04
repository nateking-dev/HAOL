import { Hono } from "hono";
import * as taskLog from "../../repositories/task-log.js";
import { findByTaskId } from "../../repositories/execution-log.js";
import { findTraceByTaskId } from "../../cascade-router/reference-store.js";
import { RouterTaskInput } from "../../types/router.js";
import { uuidv7, sha256 } from "../../types/task.js";
import * as worker from "../../services/task-worker.js";
import { NotFoundError, ValidationError } from "../middleware/error-handler.js";

const tasks = new Hono();

/**
 * Async intake. We do the bare minimum synchronously — validate, allocate
 * task_id, persist QUEUED row with the full input — then hand off to the
 * in-process worker and return 202. The pipeline (classify → select →
 * execute → commit) runs in the background and the caller polls
 * GET /tasks/:id for status.
 */
tasks.post("/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = RouterTaskInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  // Backpressure: refuse intake before writing a QUEUED row when the
  // worker queue is saturated. Returning 429 lets the caller back off
  // instead of silently piling up rows the reaper has to clean later.
  if (!worker.canAccept()) {
    c.header("Retry-After", "5");
    return c.json({ error: "task queue full, retry shortly" }, 503);
  }

  const taskId = uuidv7();
  const promptHash = sha256(parsed.data.prompt);

  await taskLog.createQueued(taskId, promptHash, {
    prompt: parsed.data.prompt,
    metadata: parsed.data.metadata as Record<string, unknown> | undefined,
    constraints: parsed.data.constraints as Record<string, unknown> | undefined,
    expected_format: parsed.data.expected_format as Record<string, unknown> | undefined,
  });
  const enqueueResult = worker.enqueue(taskId, parsed.data);
  if (enqueueResult !== "ok") {
    // Lost the race against another concurrent intake or shutdown — leave
    // the row QUEUED for the reaper rather than orphaning the caller.
    c.header("Retry-After", "5");
    return c.json({ error: "task queue unavailable, retry shortly" }, 503);
  }

  c.header("Location", `/v1/tasks/${taskId}`);
  c.header("Retry-After", "1");
  return c.json(
    {
      task_id: taskId,
      status: "QUEUED",
      links: { self: `/v1/tasks/${taskId}` },
    },
    202,
  );
});

tasks.get("/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const task = await taskLog.findById(taskId);
  if (!task) {
    throw new NotFoundError(`Task not found: ${taskId}`);
  }

  const done = task.status === "COMPLETED" || task.status === "FAILED";
  const executions = done ? await findByTaskId(taskId) : undefined;

  return c.json(
    {
      ...task,
      done,
      executions,
    },
    200,
  );
});

tasks.get("/tasks/:id/trace", async (c) => {
  const taskId = c.req.param("id");
  const trace = await findTraceByTaskId(taskId);
  if (!trace) {
    throw new NotFoundError(`No cascade trace found for task: ${taskId}`);
  }
  return c.json(trace, 200);
});

export { tasks };
