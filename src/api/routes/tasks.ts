import { Hono } from "hono";
import { RowDataPacket } from "mysql2";
import { routeTask } from "../../router/router.js";
import { findById } from "../../repositories/task-log.js";
import { findByTaskId } from "../../repositories/execution-log.js";
import { query } from "../../db/connection.js";
import { RouterTaskInput } from "../../types/router.js";
import { NotFoundError, ValidationError } from "../middleware/error-handler.js";

interface MetadataRow extends RowDataPacket {
  metadata: string | null;
}

const tasks = new Hono();

tasks.post("/tasks", async (c) => {
  const body = await c.req.json();
  const parsed = RouterTaskInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  const result = await routeTask(parsed.data);
  const statusCode = result.status === "FAILED" ? 500 : 201;
  return c.json(result, statusCode);
});

tasks.get("/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const task = await findById(taskId);
  if (!task) {
    throw new NotFoundError(`Task not found: ${taskId}`);
  }

  // Include execution log if completed/failed
  let executions = undefined;
  if (task.status === "COMPLETED" || task.status === "FAILED") {
    executions = await findByTaskId(taskId);
  }

  return c.json({ ...task, executions }, 200);
});

tasks.get("/tasks/:id/trace", async (c) => {
  const taskId = c.req.param("id");

  const rows = await query<MetadataRow[]>(
    "SELECT metadata FROM routing_log WHERE request_id = ? ORDER BY created_at DESC LIMIT 1",
    [taskId],
  );

  const row = rows[0];
  if (!row || !row.metadata) {
    throw new NotFoundError(`No cascade trace found for task: ${taskId}`);
  }

  const parsed = JSON.parse(row.metadata);
  if (!parsed.cascade_trace) {
    throw new NotFoundError(`No cascade trace found for task: ${taskId}`);
  }

  return c.json(parsed.cascade_trace, 200);
});

export { tasks };
