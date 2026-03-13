import { query } from "../db/connection.js";
import { doltCommit } from "../db/dolt.js";
import * as repo from "../repositories/agent-registry.js";
import type {
  CreateAgentInput,
  UpdateAgentInput,
  AgentRegistration,
} from "../types/agent.js";
import type { RowDataPacket } from "mysql2/promise";

interface CapabilityRow extends RowDataPacket {
  capability_key: string;
}

async function commitSafely(message: string): Promise<void> {
  try {
    await doltCommit({ message, author: "haol-service <haol@system>" });
  } catch (err) {
    if (!(err as Error).message?.includes("nothing to commit")) {
      throw err;
    }
  }
}

export async function createAgent(
  input: CreateAgentInput,
): Promise<AgentRegistration> {
  // Validate all capabilities exist in the taxonomy
  if (input.capabilities.length > 0) {
    const placeholders = input.capabilities.map(() => "?").join(", ");
    const rows = await query<CapabilityRow[]>(
      `SELECT capability_key FROM capability_taxonomy WHERE capability_key IN (${placeholders})`,
      input.capabilities,
    );

    const found = new Set(rows.map((r) => r.capability_key));
    const unknown = input.capabilities.filter((c) => !found.has(c));
    if (unknown.length > 0) {
      throw new Error(`Unknown capabilities: ${unknown.join(", ")}`);
    }
  }

  await repo.create(input);
  await commitSafely(`agent: register ${input.agent_id}`);

  const agent = await repo.findById(input.agent_id);
  return agent!;
}

export async function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
): Promise<AgentRegistration | null> {
  await repo.update(agentId, input);
  await commitSafely(`agent: update ${agentId}`);
  return repo.findById(agentId);
}

export async function deleteAgent(agentId: string): Promise<void> {
  await repo.remove(agentId);
  await commitSafely(`agent: disable ${agentId}`);
}

export async function getAgent(
  agentId: string,
): Promise<AgentRegistration | null> {
  return repo.findById(agentId);
}

export async function listAgents(filters?: {
  status?: string;
  capability?: string;
}): Promise<AgentRegistration[]> {
  return repo.findAll(filters);
}

export async function findAgentsByCapabilities(
  caps: string[],
): Promise<AgentRegistration[]> {
  return repo.findByCapabilities(caps);
}
