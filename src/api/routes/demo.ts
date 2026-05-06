import { Hono } from "hono";
import { routeTask } from "../../router/router.js";
import { RouterTaskInput } from "../../types/router.js";
import { costSavings } from "../../observability/queries.js";

const demo = new Hono();

// Anonymous-callable demo caps. Tightly bounds worst-case spend per request:
// caller-supplied constraints are clamped down (never expanded) so a public
// demo can't request 4M-token completions or hours-long timeouts.
const DEMO_MAX_TOKENS = 1024;
const DEMO_TIMEOUT_MS = 15_000;

demo.post("/demo/api/task", async (c) => {
  const body = await c.req.json();
  const parsed = RouterTaskInput.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const input = parsed.data;
  const clamped: RouterTaskInput = {
    ...input,
    constraints: {
      ...input.constraints,
      max_tokens: Math.min(input.constraints?.max_tokens ?? DEMO_MAX_TOKENS, DEMO_MAX_TOKENS),
      timeout_ms: Math.min(input.constraints?.timeout_ms ?? DEMO_TIMEOUT_MS, DEMO_TIMEOUT_MS),
    },
  };

  const result = await routeTask(clamped);
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
