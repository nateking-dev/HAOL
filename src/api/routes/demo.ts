import { Hono } from "hono";
import { routeTask } from "../../router/router.js";
import { RouterTaskInput } from "../../types/router.js";
import { costSavings } from "../../observability/queries.js";

const demo = new Hono();

demo.post("/demo/api/task", async (c) => {
  const body = await c.req.json();
  const parsed = RouterTaskInput.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const result = await routeTask(parsed.data);
  return c.json(result, result.status === "FAILED" ? 500 : 201);
});

demo.get("/demo/api/savings", async (c) => {
  const since = c.req.query("since");
  if (since) {
    const sinceDate = new Date(since);
    const hours = Math.max(1, (Date.now() - sinceDate.getTime()) / 3_600_000);
    const data = await costSavings(Math.ceil(hours));
    return c.json(data, 200);
  }
  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const data = await costSavings(Math.max(1, Math.min(hours, 8760)));
  return c.json(data, 200);
});

export { demo };
