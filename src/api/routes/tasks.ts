import { Hono } from "hono";
import { routeTask } from "../../router/router.js";
import { findById } from "../../repositories/task-log.js";
import { findByTaskId } from "../../repositories/execution-log.js";
import { RouterTaskInput } from "../../types/router.js";
import { NotFoundError, ValidationError } from "../middleware/error-handler.js";

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

export { tasks };
