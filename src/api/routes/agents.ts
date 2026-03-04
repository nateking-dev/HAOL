import { Hono } from "hono";
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
} from "../../services/agent-registry.js";
import { CreateAgentInput, UpdateAgentInput } from "../../types/agent.js";
import { NotFoundError, ValidationError } from "../middleware/error-handler.js";

const agents = new Hono();

agents.get("/agents", async (c) => {
  const status = c.req.query("status");
  const capability = c.req.query("capability");
  const filters: { status?: string; capability?: string } = {};
  if (status) filters.status = status;
  if (capability) filters.capability = capability;

  const result = await listAgents(
    Object.keys(filters).length > 0 ? filters : undefined,
  );
  return c.json(result, 200);
});

agents.post("/agents", async (c) => {
  const body = await c.req.json();
  const parsed = CreateAgentInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  const agent = await createAgent(parsed.data);
  return c.json(agent, 201);
});

agents.put("/agents/:id", async (c) => {
  const agentId = c.req.param("id");
  const body = await c.req.json();
  const parsed = UpdateAgentInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  const existing = await getAgent(agentId);
  if (!existing) {
    throw new NotFoundError(`Agent not found: ${agentId}`);
  }

  const updated = await updateAgent(agentId, parsed.data);
  return c.json(updated, 200);
});

agents.delete("/agents/:id", async (c) => {
  const agentId = c.req.param("id");

  const existing = await getAgent(agentId);
  if (!existing) {
    throw new NotFoundError(`Agent not found: ${agentId}`);
  }

  await deleteAgent(agentId);
  return c.json({ message: `Agent ${agentId} disabled` }, 200);
});

export { agents };
