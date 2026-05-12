import { Hono } from "hono";
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  CapabilityValidationError,
} from "../../services/agent-registry.js";
import { CreateAgentInput, UpdateAgentInput } from "../../types/agent.js";
import { NotFoundError, ValidationError } from "../middleware/error-handler.js";
import { parseJsonBody } from "../request-body.js";

const agents = new Hono();

function mapCapabilityValidationError(err: unknown): never {
  if (err instanceof CapabilityValidationError) {
    throw new ValidationError(err.message);
  }
  throw err;
}

agents.get("/agents", async (c) => {
  const status = c.req.query("status");
  const capability = c.req.query("capability");
  const filters: { status?: string; capability?: string } = {};
  if (status) filters.status = status;
  if (capability) filters.capability = capability;

  const result = await listAgents(Object.keys(filters).length > 0 ? filters : undefined);
  return c.json(result, 200);
});

agents.post("/agents", async (c) => {
  const body = await parseJsonBody(c);
  const parsed = CreateAgentInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  const agent = await createAgent(parsed.data).catch(mapCapabilityValidationError);
  return c.json(agent, 201);
});

agents.put("/agents/:id", async (c) => {
  const agentId = c.req.param("id");
  const body = await parseJsonBody(c);
  const parsed = UpdateAgentInput.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.message);
  }

  const existing = await getAgent(agentId);
  if (!existing) {
    throw new NotFoundError(`Agent not found: ${agentId}`);
  }

  const updated = await updateAgent(agentId, parsed.data).catch(mapCapabilityValidationError);
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
