# Heterogeneous Agent Orchestration Layer

**HAOL** (pronounced "Hal")

MVP Specification — Dolt-backed persistence and memory layer

Author: Nate King | Status: Draft | Date: March 2026

---

## 1. Problem Statement

Agent orchestration systems today overwhelmingly assume a homogeneous model pool: every agent is backed by the same provider, the same model, the same cost profile. This simplifies the orchestrator but produces two failure modes. First, tasks that require only shallow reasoning are routed through the same expensive model as tasks requiring deep analysis, burning inference budget without proportional value. Second, tasks that require specialized capabilities—long-context retrieval, structured output, vision—are force-fit into a generalist model rather than dispatched to the model best suited for the work.

HAOL addresses this by treating model heterogeneity as a first-class architectural concern. The router evaluates each incoming task against a registry of agents with distinct capability profiles, cost envelopes, and latency characteristics, then dispatches accordingly. Dolt serves as the persistence layer, providing Git-style version control over every configuration change, routing decision, and agent state transition. The result is an orchestration system where routing logic is auditable, reversible, and diffable—not a black box.

---

## 2. Design Principles

- **Provider-agnostic by default.** The router treats models as capability surfaces, not brand names. An agent backed by Claude, GPT, Gemini, Mistral, or a local model is registered with the same schema. The orchestrator neither knows nor cares who is behind the interface.
- **Cost as a routing dimension.** Inference cost is not an afterthought. Every agent registration includes a cost profile (per-token input/output pricing, minimum latency, rate limits). The router factors cost constraints into every dispatch decision alongside capability match.
- **Version-controlled state.** All system configuration—agent registrations, routing rules, capability taxonomies—lives in Dolt. Changes are committed, diffable, and reversible. No configuration drift. No mystery mutations.
- **Branching as isolation.** Experimental routing policies are tested on Dolt branches. Promote by merging to main. Roll back by reverting the commit. The same Git mental model your engineers already have, applied to orchestration configuration.
- **Observability from the storage layer.** Because Dolt tracks every cell-level mutation, the audit trail is intrinsic. You do not bolt on logging; the database is the log.

---

## 3. System Architecture

### 3.1 Component Overview

HAOL is composed of five core subsystems. Each is described below with its responsibilities, interfaces, and relationship to the Dolt persistence layer.

| Component            | Responsibility                                                                     | Dolt Integration                                                   |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Router**           | Receives tasks, classifies complexity, dispatches to agents                        | Reads `agent_registry`, writes to `task_log` on every dispatch     |
| **Agent Registry**   | Stores agent definitions: capabilities, cost profiles, constraints, health status  | Versioned table; changes committed with author and message         |
| **Task Classifier**  | Evaluates inbound tasks for type, complexity tier, and required capabilities       | Reads `capability_taxonomy`; writes classification to `task_log`   |
| **Memory Manager**   | Manages agent context windows, conversation state, and cross-agent handoff context | Branched workspaces per agent session; merged on completion        |
| **Execution Engine** | Invokes the selected agent, handles retries, fallbacks, timeouts                   | Writes execution results, latency, token counts to `execution_log` |

### 3.2 Request Lifecycle

A task enters HAOL through a single entry point and proceeds through a deterministic pipeline. Each stage writes its output to Dolt before advancing, ensuring every intermediate state is recoverable.

1. **Intake.** The Router receives a task payload (prompt, metadata, constraints). It assigns a `task_id` and writes the raw request to `task_log` with `status = RECEIVED`.
2. **Classification.** The Task Classifier evaluates the payload against the `capability_taxonomy`. It produces a `TaskClassification` record: complexity tier (T1–T4), required capabilities, and cost ceiling. Written to `task_log`.
3. **Agent Selection.** The Router queries `agent_registry WHERE status = 'active'` and filters on capability match, cost ceiling, and current load. It scores candidates using a weighted function (capability match × 0.5 + cost efficiency × 0.3 + latency × 0.2). Writes the selected `agent_id` and score rationale to `task_log`.
4. **Context Assembly.** The Memory Manager assembles the context window for the selected agent. If prior conversation state exists, it checks out the relevant Dolt branch, reads prior context, and constructs the prompt. For cross-agent handoffs, it reads the handoff summary from the prior agent's branch.
5. **Execution.** The Execution Engine invokes the agent's provider API. It enforces timeout and retry policy. On completion, it writes the full execution record (response, token counts, latency, cost) to `execution_log`.
6. **Commit.** On successful execution, HAOL issues a `CALL DOLT_COMMIT()` capturing the complete task lifecycle as a single atomic version. On failure, the working set is rolled back.

---

## 4. Dolt Schema Design

The schema below represents the MVP data model. All tables live in a single Dolt database (`haol`). Version control operations—branching, committing, diffing—are performed via Dolt's SQL stored procedures and system tables.

### 4.1 agent_registry

The canonical source of truth for all agents available to HAOL. Each row represents one agent configuration.

| Column               | Type          | Constraint  | Description                                             |
| -------------------- | ------------- | ----------- | ------------------------------------------------------- |
| `agent_id`           | VARCHAR(64)   | PRIMARY KEY | Unique identifier (e.g., `claude-sonnet-4-5`)           |
| `provider`           | VARCHAR(32)   | NOT NULL    | Provider key (`anthropic`, `openai`, `google`, `local`) |
| `model_id`           | VARCHAR(128)  | NOT NULL    | Provider-specific model string                          |
| `capabilities`       | JSON          | NOT NULL    | Array of capability tags from taxonomy                  |
| `cost_per_1k_input`  | DECIMAL(10,6) | NOT NULL    | USD per 1,000 input tokens                              |
| `cost_per_1k_output` | DECIMAL(10,6) | NOT NULL    | USD per 1,000 output tokens                             |
| `max_context_tokens` | INT           | NOT NULL    | Maximum context window size                             |
| `avg_latency_ms`     | INT           | DEFAULT 0   | Rolling average TTFT in milliseconds                    |
| `status`             | ENUM          | NOT NULL    | `active` \| `degraded` \| `disabled`                    |
| `tier_ceiling`       | TINYINT       | NOT NULL    | Max complexity tier this agent handles (1–4)            |

### 4.2 capability_taxonomy

A controlled vocabulary for agent capabilities. The router matches task requirements against this taxonomy to produce a candidate set.

| Column           | Type         | Constraint  | Description                                   |
| ---------------- | ------------ | ----------- | --------------------------------------------- |
| `capability_key` | VARCHAR(64)  | PRIMARY KEY | Canonical key (e.g., `long_context`)          |
| `display_name`   | VARCHAR(128) | NOT NULL    | Human-readable label                          |
| `description`    | TEXT         |             | What this capability means for routing        |
| `tier_minimum`   | TINYINT      | DEFAULT 1   | Lowest complexity tier where this is relevant |

### 4.3 task_log

The immutable record of every task that enters the system. Each row is append-only within a transaction; the status field advances through the lifecycle (`RECEIVED → CLASSIFIED → DISPATCHED → COMPLETED | FAILED`).

| Column                  | Type          | Description                                                           |
| ----------------------- | ------------- | --------------------------------------------------------------------- |
| `task_id`               | VARCHAR(36)   | UUIDv7 (time-sortable). Primary key.                                  |
| `created_at`            | TIMESTAMP     | Intake timestamp.                                                     |
| `status`                | ENUM          | `RECEIVED` \| `CLASSIFIED` \| `DISPATCHED` \| `COMPLETED` \| `FAILED` |
| `prompt_hash`           | VARCHAR(64)   | SHA-256 of the raw prompt (for deduplication).                        |
| `complexity_tier`       | TINYINT       | T1–T4 classification result. NULL until classified.                   |
| `required_capabilities` | JSON          | Array of `capability_key`s required for this task.                    |
| `cost_ceiling_usd`      | DECIMAL(10,6) | Max allowable cost for this task execution.                           |
| `selected_agent_id`     | VARCHAR(64)   | FK to `agent_registry`. NULL until dispatched.                        |
| `selection_rationale`   | JSON          | Scoring breakdown: `{ capability_score, cost_score, latency_score }`. |

### 4.4 execution_log

Detailed execution telemetry. One row per agent invocation (retries produce additional rows linked to the same `task_id`).

| Column           | Type          | Description                                     |
| ---------------- | ------------- | ----------------------------------------------- |
| `execution_id`   | VARCHAR(36)   | UUIDv7. Primary key.                            |
| `task_id`        | VARCHAR(36)   | FK to `task_log`.                               |
| `agent_id`       | VARCHAR(64)   | FK to `agent_registry`.                         |
| `attempt_number` | TINYINT       | 1-indexed retry counter.                        |
| `input_tokens`   | INT           | Tokens sent.                                    |
| `output_tokens`  | INT           | Tokens received.                                |
| `cost_usd`       | DECIMAL(10,6) | Computed cost for this invocation.              |
| `latency_ms`     | INT           | Total round-trip time.                          |
| `ttft_ms`        | INT           | Time to first token.                            |
| `outcome`        | ENUM          | `SUCCESS` \| `TIMEOUT` \| `ERROR` \| `FALLBACK` |
| `error_detail`   | TEXT          | Error message or null on success.               |

### 4.5 routing_policy

Configurable rules that govern routing behavior. These are the knobs operators turn without touching code. Because they live in Dolt, every policy change is a committed, diffable event.

| Column              | Type         | Description                                                             |
| ------------------- | ------------ | ----------------------------------------------------------------------- |
| `policy_id`         | VARCHAR(64)  | Primary key. Human-readable (e.g., `default`, `cost_aggressive`).       |
| `weight_capability` | DECIMAL(3,2) | Weight for capability match score (0.00–1.00).                          |
| `weight_cost`       | DECIMAL(3,2) | Weight for cost efficiency score.                                       |
| `weight_latency`    | DECIMAL(3,2) | Weight for latency score.                                               |
| `fallback_strategy` | ENUM         | `NEXT_BEST` \| `TIER_UP` \| `ABORT`. Behavior on primary agent failure. |
| `max_retries`       | TINYINT      | Maximum retry attempts before fallback.                                 |
| `active`            | BOOLEAN      | Only one policy may be active at a time.                                |

---

## 5. Dolt Versioning Patterns

The value proposition of Dolt is not that it is a MySQL-compatible database (many options exist for that). The value is that every mutation to the orchestration state is a committed, branchable, diffable event. The following patterns describe how HAOL exploits this.

### 5.1 Operational Commits

Every completed task lifecycle produces a Dolt commit. The commit message is machine-generated and structured for queryability:

```sql
CALL DOLT_COMMIT(
  '-m', 'task:a1b2c3d4 | tier:T2 | agent:claude-haiku-4-5 | cost:$0.0023 | 342ms',
  '--author', 'haol-router <haol@system>'
);
```

This structured commit message enables powerful queries against `dolt_log` for operational analytics without leaving SQL.

### 5.2 Configuration Branches

When an operator wants to test a new routing policy or register a new agent, they work on a Dolt branch:

```sql
CALL DOLT_BRANCH('experiment/cost-aggressive-policy');
CALL DOLT_CHECKOUT('experiment/cost-aggressive-policy');

-- Modify routing_policy, agent_registry, etc.
UPDATE routing_policy SET weight_cost = 0.60, weight_capability = 0.30
  WHERE policy_id = 'default';

CALL DOLT_COMMIT('-am', 'experiment: increase cost weight to 0.60');
```

A shadow routing mode can evaluate the experimental branch against production traffic (logging the would-have-been routing decision without executing it). When validated, the branch merges to main:

```sql
CALL DOLT_CHECKOUT('main');
CALL DOLT_MERGE('experiment/cost-aggressive-policy');
```

### 5.3 Time-Travel Auditing

Dolt's `AS OF` syntax enables point-in-time queries against any prior commit. This is essential for compliance and incident investigation:

```sql
-- What was the agent registry at commit main~5?
SELECT * FROM agent_registry AS OF 'main~5';

-- What changed between two commits?
SELECT * FROM dolt_diff_agent_registry
  WHERE from_commit = 'abc123' AND to_commit = 'def456';
```

### 5.4 Conflict Resolution on Merge

When concurrent branches modify the same agent registration or policy row, Dolt surfaces cell-level merge conflicts via the `dolt_conflicts` system table. HAOL adopts a simple resolution strategy for the MVP: configuration conflicts are resolved `--ours` (the mainline wins), and a notification is emitted to operators to review the rejected change. Post-MVP, a review queue modeled on pull requests is the natural extension.

---

## 6. Complexity Tier Model

The Task Classifier assigns every inbound task a complexity tier from T1 through T4. Tiers map directly to the cost and capability band the router will consider. This is the core routing heuristic.

| Tier   | Label    | Characteristics                                                                      | Typical Agents                                          |
| ------ | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **T1** | Trivial  | Pattern-matchable. Keyword extraction, simple classification, template fill.         | Haiku-class, local SLMs, regex/rule engines             |
| **T2** | Standard | Requires reasoning but not deep analysis. Summarization, Q&A, structured extraction. | Sonnet-class, GPT-4o-mini                               |
| **T3** | Complex  | Multi-step reasoning, long-context synthesis, ambiguous inputs requiring judgment.   | Opus-class, GPT-4o, Gemini Pro                          |
| **T4** | Expert   | Multi-agent orchestration, tool use chains, adversarial inputs, safety-critical.     | Opus-class with extended thinking, multi-agent pipeline |

The classifier itself is a lightweight agent (T1-capable model) that evaluates the incoming prompt and emits a structured classification. This means the classification step costs fractions of a cent, which is the point: you spend almost nothing to determine how much to spend.

---

## 7. Agent Selection Algorithm

Given a classified task with tier T, required capabilities C, and cost ceiling M, the router produces a ranked candidate list using the following procedure.

**Step 1: Filter**

Query `agent_registry` for all active agents where `tier_ceiling >= T` and the agent's `capabilities` JSON contains all elements of C. Exclude any agent whose `cost_per_1k_input + cost_per_1k_output` (estimated for the task's token budget) would exceed M.

**Step 2: Score**

For each candidate, compute a weighted score:

```
score = (capability_overlap / required_count) * W_capability
      + (1 - normalized_cost)                * W_cost
      + (1 - normalized_latency)              * W_latency
```

Weights W are drawn from the active `routing_policy` row. Normalization is within the candidate set (min-max scaling).

**Step 3: Select**

The highest-scoring candidate is selected. The score breakdown is written to `task_log.selection_rationale` as a JSON object for post-hoc analysis. If the candidate set is empty after filtering, the router applies the `fallback_strategy` from `routing_policy`: `NEXT_BEST` relaxes the cost ceiling by 20%, `TIER_UP` bumps the complexity tier and re-runs selection, `ABORT` returns an error to the caller.

---

## 8. Memory Management via Dolt Branches

Agent memory in HAOL is not a vector store bolted onto the side. It is the database itself. Each active agent session operates on a Dolt branch, and the branch contains the full conversational and decisional context for that session.

### 8.1 Session Branches

When a task enters execution, the Memory Manager creates a session branch:

```sql
CALL DOLT_BRANCH('session/a1b2c3d4');
CALL DOLT_CHECKOUT('session/a1b2c3d4');
```

All writes during execution (intermediate results, tool call logs, agent scratch state) are committed to this branch. On successful completion, the branch merges results into main. On failure, the branch is preserved for debugging but never merged.

### 8.2 Context Tables

Within a session branch, two tables manage agent context:

- **session_context:** Key-value store for the current session's working memory. Keys are namespaced (e.g., `user_intent`, `extracted_entities`, `tool_results`). Values are JSON.
- **handoff_summary:** When a task escalates from one agent to another (e.g., T2 agent realizes it needs T3), the outgoing agent writes a structured summary here. The incoming agent reads it as part of context assembly.

### 8.3 Branch Lifecycle

Session branches are ephemeral by design. A background process prunes merged branches older than a configurable retention window (default: 7 days). Failed branches are retained longer (default: 30 days) for forensic purposes. Because Dolt's storage is content-addressed, branches that share most of their data with main consume minimal additional disk.

---

## 9. MVP Scope and Boundaries

The MVP is deliberately constrained. The following table draws the line between what ships in v0.1 and what is deferred.

| In Scope (v0.1)                                | Deferred (v0.2+)                               |
| ---------------------------------------------- | ---------------------------------------------- |
| Single-task routing (one task, one agent)      | Multi-agent pipelines (chained tasks)          |
| Static complexity classification (rules-based) | Adaptive classification (learns from outcomes) |
| 3 providers (Anthropic, OpenAI, local)         | Plugin-based provider extensibility            |
| Weighted scoring selection                     | ML-based selection (bandit/RL)                 |
| Synchronous execution only                     | Async execution with callbacks                 |
| Single Dolt instance                           | Dolt replication for HA                        |
| CLI and API interface                          | Web dashboard with Dolt diff viewer            |
| Manual policy configuration                    | A/B policy testing with automatic promotion    |
| Session branches for memory                    | Long-term memory with semantic retrieval       |

---

## 10. Provider Interface Contract

Every agent provider implements a single interface. HAOL does not depend on provider-specific SDKs at the orchestration layer; adapters translate the uniform interface to provider APIs.

```typescript
interface AgentProvider {
  invoke(request: AgentRequest): Promise<AgentResponse>;
  healthCheck(): Promise<HealthStatus>;
  estimateTokens(prompt: string): number;
}

interface AgentRequest {
  task_id: string;
  prompt: string;
  system_prompt?: string;
  context: Record<string, any>;
  constraints: {
    max_tokens: number;
    timeout_ms: number;
    temperature?: number;
  };
}

interface AgentResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  ttft_ms: number;
  total_ms: number;
  metadata: Record<string, any>;
}
```

The adapter pattern means adding a new provider is a single file implementing `AgentProvider`. Registration in `agent_registry` makes it immediately available to the router. No orchestration code changes.

---

## 11. Observability and Auditing

HAOL's observability story is built on a simple premise: the database is the log. Because every state mutation is a Dolt commit with a structured message, the entire operational history is queryable via standard SQL.

### 11.1 Operational Queries

```sql
-- Cost by agent over last 24 hours
SELECT agent_id, SUM(cost_usd) as total_cost, COUNT(*) as invocations
  FROM execution_log
  WHERE created_at > NOW() - INTERVAL 24 HOUR
  GROUP BY agent_id ORDER BY total_cost DESC;

-- Tasks that exceeded cost ceiling
SELECT t.task_id, t.cost_ceiling_usd, e.cost_usd
  FROM task_log t JOIN execution_log e ON t.task_id = e.task_id
  WHERE e.cost_usd > t.cost_ceiling_usd;

-- Agent registry changes in last 7 days
SELECT * FROM dolt_diff_agent_registry
  WHERE to_commit IN (
    SELECT commit_hash FROM dolt_log WHERE date > NOW() - INTERVAL 7 DAY
  );
```

### 11.2 Audit Guarantees

Dolt provides three properties that traditional logging cannot match. First, immutability: committed data cannot be silently modified; any change produces a new commit with a diff against the prior state. Second, attribution: every commit carries an author, so configuration changes are always traceable to a human or system actor. Third, reproducibility: given a commit hash, the exact state of every table can be reconstructed, which is essential for incident postmortems and regulatory review.

---

## 12. MVP Deployment Topology

The MVP runs as a single-process TypeScript/Node application with Dolt running as an embedded SQL server on the same host. This is intentionally simple. The boundaries between components are clean enough that decomposition into separate services is straightforward when scale requires it, but premature distribution is not an MVP concern.

**Runtime Stack**

- **Application:** TypeScript on Node.js 20+ with native fetch for provider API calls, mysql2 for Dolt.
- **Persistence:** Dolt sql-server (MySQL-compatible, local).
- **API surface:** Hono (or Express) exposing `/task` (submit), `/status/{task_id}` (poll), `/agents` (registry CRUD) with OpenAPI spec via zod-openapi.
- **Infrastructure:** Single EC2 instance or ECS task. Dolt data stored on EBS with daily snapshots.

**Configuration**

All runtime configuration flows through Dolt. There are no environment variables governing routing behavior, no YAML files, no feature flags in a separate system. The `routing_policy` table is the single source of truth. Environment variables are reserved for infrastructure concerns only: database connection strings, provider API keys (via AWS Secrets Manager references), and log levels.

---

## 13. Open Questions

The following decisions are intentionally deferred. They require either empirical data from running the MVP or broader team input.

- **Classification model.** Should the Task Classifier be a dedicated small model (e.g., Haiku), a fine-tuned classifier, or a rules engine? The MVP ships with a rules engine and evaluates whether model-based classification produces meaningfully better routing.
- **Commit granularity.** One Dolt commit per task is clean but may produce too many commits under high throughput. Batching commits (e.g., every N tasks or every T seconds) trades auditability granularity for write performance. The MVP commits per-task and measures.
- **Cost model staleness.** Provider pricing changes. How frequently should HAOL refresh `cost_per_1k_input`/`output` in `agent_registry`? Manual update on a Dolt branch is the MVP path; automated scraping is a v0.2 concern.
- **Multi-tenancy.** If HAOL serves multiple downstream applications, should tenants share a Dolt database (with `tenant_id` columns) or receive separate databases? Separate databases align better with Dolt's branching model but increase operational overhead.
- **Dolt performance envelope.** Dolt's write throughput is lower than vanilla MySQL due to content-addressed storage. The MVP needs to characterize the actual throughput ceiling under realistic task volumes to determine when (not if) write batching becomes necessary.
