# HAOL Implementation Plan

**11 stories, independently testable, ordered by dependency**

Runtime: TypeScript + Node 20, Hono, Vitest, mysql2/promise, Dolt

---

## Story 0: Project Scaffolding + Dolt Connection

**Goal:** Standing TypeScript project that compiles, runs tests, and connects to a Dolt SQL server.

**Dependencies:** None

**Files to create:**

```
haol/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example            # DOLT_HOST, DOLT_PORT, DOLT_USER, DOLT_PASSWORD, DOLT_DATABASE
├── src/
│   ├── index.ts            # Entry point (placeholder)
│   ├── config.ts           # Loads env vars, exports typed config object
│   └── db/
│       ├── connection.ts   # mysql2 pool creation, health-check query
│       └── dolt.ts         # Helpers: doltCommit(), doltCheckout(), doltBranch(), doltMerge()
└── tests/
    └── db/
        └── connection.test.ts
```

**Key decisions:**

- `mysql2/promise` — Dolt is wire-compatible with MySQL; no ORM needed for MVP.
- Pool-based connection with configurable pool size (default 5).
- `dolt.ts` wraps `CALL DOLT_COMMIT(...)`, `CALL DOLT_CHECKOUT(...)`, etc. as typed async functions.

**Acceptance criteria:**

1. `npm run build` compiles with zero errors.
2. `npm test` runs vitest and all tests pass.
3. `connection.test.ts` connects to Dolt, runs `SELECT 1`, and disconnects.
4. `dolt.ts` exports `doltCommit`, `doltCheckout`, `doltBranch`, `doltMerge` — each calls the corresponding stored procedure.

**Testing strategy:**

- Integration test against a running Dolt instance (local Docker or installed binary).
- Use a `beforeAll` hook that verifies the Dolt server is reachable; skip with a clear message if not.

---

## Story 1: Dolt Schema + Migrations

**Goal:** Create all MVP tables in Dolt via a repeatable migration script. Seed the `capability_taxonomy` with initial values.

**Dependencies:** Story 0

**Files to create:**

```
src/db/
├── migrations/
│   ├── 001_create_agent_registry.sql
│   ├── 002_create_capability_taxonomy.sql
│   ├── 003_create_task_log.sql
│   ├── 004_create_execution_log.sql
│   ├── 005_create_routing_policy.sql
│   ├── 006_create_session_context.sql
│   ├── 007_create_handoff_summary.sql
│   └── 008_seed_capability_taxonomy.sql
├── migrate.ts              # Reads and applies .sql files in order, idempotent
└── seed.ts                 # Inserts default routing_policy + sample agents for dev
tests/db/
└── migrations.test.ts
```

**Tables (from architecture spec §4):**

| Table | Primary Key |
|-------|-------------|
| `agent_registry` | `agent_id VARCHAR(64)` |
| `capability_taxonomy` | `capability_key VARCHAR(64)` |
| `task_log` | `task_id VARCHAR(36)` |
| `execution_log` | `execution_id VARCHAR(36)` |
| `routing_policy` | `policy_id VARCHAR(64)` |
| `session_context` | `session_id VARCHAR(36), key VARCHAR(128)` composite PK |
| `handoff_summary` | `task_id VARCHAR(36), from_agent_id VARCHAR(64)` composite PK |

**Seed data for `capability_taxonomy`:**

```
long_context, structured_output, code_generation, summarization,
classification, vision, tool_use, reasoning, multilingual
```

**Seed data for `routing_policy`:**

```
policy_id: 'default'
weight_capability: 0.50, weight_cost: 0.30, weight_latency: 0.20
fallback_strategy: 'NEXT_BEST', max_retries: 2, active: true
```

**Acceptance criteria:**

1. `npm run migrate` applies all SQL files in order.
2. Running `migrate` twice is idempotent (no errors on re-run).
3. All 7 tables exist with correct column types verified by `DESCRIBE <table>`.
4. `capability_taxonomy` contains 9 seed rows.
5. `routing_policy` contains 1 default row.
6. A Dolt commit is created after migration: `CALL DOLT_COMMIT('-am', 'migration: initial schema')`.

**Testing strategy:**

- Integration test: run migrate, then query `INFORMATION_SCHEMA.TABLES` to verify all tables exist.
- Integration test: run migrate twice, assert no errors.
- Integration test: `SELECT COUNT(*) FROM capability_taxonomy` = 9.

---

## Story 2: Agent Registry CRUD

**Goal:** Full create/read/update/delete for agent registrations, backed by Dolt with commits on every mutation.

**Dependencies:** Story 1

**Parallelizable with:** Story 3

**Files to create:**

```
src/
├── types/
│   └── agent.ts            # AgentRegistration type, CreateAgentInput, UpdateAgentInput (Zod schemas)
├── repositories/
│   └── agent-registry.ts   # SQL queries: findAll, findById, findByCapabilities, create, update, delete
└── services/
    └── agent-registry.ts   # Business logic: validate capabilities against taxonomy, commit changes
tests/
├── types/
│   └── agent.test.ts       # Zod schema validation tests (unit)
├── repositories/
│   └── agent-registry.test.ts  # Query correctness (integration)
└── services/
    └── agent-registry.test.ts  # Business logic (integration)
```

**Key behaviors:**

- `create()` validates that all `capabilities` entries exist in `capability_taxonomy`. Rejects unknown capabilities.
- `update()` does a partial update (only supplied fields change). Commits with message: `agent: update <agent_id> — <changed_fields>`.
- `delete()` sets `status = 'disabled'` (soft delete). Hard delete is a separate operation requiring confirmation.
- `findByCapabilities(caps: string[])` uses `JSON_CONTAINS` to match agents that have all required capabilities.
- Every write operation calls `doltCommit()` from Story 0.

**Acceptance criteria:**

1. Create an agent → read it back → fields match.
2. Create with unknown capability → error thrown.
3. Update cost fields → Dolt commit created with descriptive message.
4. Soft-delete → agent `status` is `disabled`, still readable.
5. `findByCapabilities(['code_generation', 'reasoning'])` returns only agents with both.
6. Dolt log shows one commit per mutation with structured message.

**Testing strategy:**

- Unit tests for Zod schema validation (no DB needed).
- Integration tests for repository (against Dolt): each test runs in a transaction that rolls back.
- Integration tests for service: create → update → verify commit in `dolt_log`.

---

## Story 3: Task Classifier (Rules Engine)

**Goal:** A rules-based classifier that evaluates an incoming task prompt and produces a complexity tier (T1–T4) plus required capabilities.

**Dependencies:** Story 1

**Parallelizable with:** Story 2

**Files to create:**

```
src/
├── types/
│   └── task.ts             # TaskInput, TaskClassification (Zod schemas)
├── classifier/
│   ├── rules.ts            # Rule definitions: keyword patterns, heuristics
│   ├── classifier.ts       # evaluate(prompt, metadata?) → TaskClassification
│   └── scoring.ts          # Internal: score each dimension, combine into tier
tests/
├── classifier/
│   ├── rules.test.ts       # Individual rule correctness (unit)
│   ├── classifier.test.ts  # End-to-end classification (unit)
│   └── fixtures/
│       └── prompts.json    # Test fixtures: { prompt, expectedTier, expectedCapabilities }[]
```

**Classification rules (MVP, rules engine per §13):**

| Signal | How Detected | Effect |
|--------|-------------|--------|
| Token count | `prompt.length / 4` (rough estimate) | > 2000 tokens → bump tier |
| Keyword: "summarize", "extract", "classify" | Regex match | T1–T2, add `summarization` or `classification` |
| Keyword: "analyze", "compare", "reason" | Regex match | T2–T3, add `reasoning` |
| Keyword: "code", "implement", "function", "debug" | Regex match | T2–T3, add `code_generation` |
| Keyword: "image", "screenshot", "diagram" | Regex match | Add `vision` |
| Multiple capabilities required | Count > 3 | Bump tier |
| Explicit user constraint: `tier` in metadata | Direct pass-through | Override |
| Explicit user constraint: `capabilities` in metadata | Direct pass-through | Merge with detected |

**`TaskClassification` output shape:**

```typescript
{
  task_id: string;          // UUIDv7, assigned here
  complexity_tier: 1 | 2 | 3 | 4;
  required_capabilities: string[];
  cost_ceiling_usd: number; // Derived from tier: T1=$0.01, T2=$0.05, T3=$0.50, T4=$5.00
  prompt_hash: string;      // SHA-256 of raw prompt
}
```

**Acceptance criteria:**

1. `"Summarize this paragraph"` → T1, capabilities: `['summarization']`.
2. `"Analyze this codebase and suggest refactoring strategies"` → T3, capabilities: `['code_generation', 'reasoning']`.
3. `"Classify this image and extract structured data"` → T3, capabilities: `['vision', 'classification', 'structured_output']`.
4. Metadata override `{ tier: 4 }` → T4 regardless of prompt content.
5. `prompt_hash` is deterministic for the same input.
6. Every classification produces a valid UUIDv7 `task_id`.

**Testing strategy:**

- Pure unit tests — no database needed. The classifier is stateless.
- Fixture-driven: `prompts.json` contains 20+ test cases covering each rule and edge cases.
- Property-based: tier is always 1–4, capabilities array is always a subset of the taxonomy.

---

## Story 4: Agent Selection Algorithm

**Goal:** Given a `TaskClassification` and the active `routing_policy`, query the agent registry and return a scored, ranked list of candidates.

**Dependencies:** Story 2, Story 3

**Files to create:**

```
src/
├── types/
│   └── selection.ts        # SelectionResult, ScoredCandidate, SelectionRationale (Zod schemas)
├── services/
│   └── agent-selection.ts  # select(classification, policy?) → SelectionResult
tests/
├── services/
│   └── agent-selection.test.ts
```

**Algorithm (from architecture spec §7):**

1. **Filter:** `agent_registry WHERE status = 'active' AND tier_ceiling >= classification.complexity_tier` and `JSON_CONTAINS(capabilities, required_capabilities)` and estimated cost <= `cost_ceiling_usd`.
2. **Score:** For each candidate:
   - `capability_score` = (number of matching capabilities) / (number of required capabilities)
   - `cost_score` = 1 - ((agent cost estimate) - min_cost) / (max_cost - min_cost) — normalized within candidate set
   - `latency_score` = 1 - ((agent avg_latency_ms) - min_latency) / (max_latency - min_latency)
   - `total = capability_score * W_cap + cost_score * W_cost + latency_score * W_latency`
3. **Select:** Highest score wins. On empty candidate set, apply `fallback_strategy`:
   - `NEXT_BEST`: relax cost ceiling by 20%, re-run.
   - `TIER_UP`: increment tier, re-run.
   - `ABORT`: throw `NoAgentAvailableError`.

**`SelectionResult` shape:**

```typescript
{
  selected_agent_id: string;
  scored_candidates: ScoredCandidate[];  // Full ranked list for audit
  rationale: {
    capability_score: number;
    cost_score: number;
    latency_score: number;
    total_score: number;
  };
  fallback_applied: 'NONE' | 'NEXT_BEST' | 'TIER_UP';
}
```

**Acceptance criteria:**

1. Given 3 agents with varying costs and capabilities, the cheapest capable agent wins under default weights.
2. Changing `weight_cost` to 0.0 and `weight_capability` to 1.0 → the most capable agent wins regardless of cost.
3. No capable agents → `NEXT_BEST` relaxes ceiling and finds an agent.
4. Still no agents after fallback → `ABORT` throws `NoAgentAvailableError`.
5. `selection_rationale` contains per-dimension scores.
6. Single candidate → scores are all 1.0 (trivial normalization).

**Testing strategy:**

- Integration tests with seeded agent data in Dolt.
- Test each fallback strategy in isolation.
- Test edge case: single candidate, zero candidates, all candidates identical score (deterministic tiebreak by `agent_id` alphabetical).

---

## Story 5: Execution Engine (Providers + Retry)

**Goal:** Invoke an agent's provider API, enforce timeout/retry policy, and record execution telemetry.

**Dependencies:** Story 2

**Parallelizable with:** Story 4

**Files to create:**

```
src/
├── types/
│   └── execution.ts        # AgentRequest, AgentResponse, ExecutionRecord (Zod schemas)
├── providers/
│   ├── provider.ts         # AgentProvider interface
│   ├── anthropic.ts        # Anthropic adapter (raw fetch to messages API)
│   ├── openai.ts           # OpenAI adapter (raw fetch to chat completions API)
│   └── local.ts            # Local/Ollama adapter (raw fetch to localhost)
├── services/
│   └── execution.ts        # execute(agentId, request, policy) → ExecutionRecord
├── repositories/
│   └── execution-log.ts    # Insert execution_log row
tests/
├── providers/
│   ├── anthropic.test.ts
│   ├── openai.test.ts
│   └── local.test.ts
├── services/
│   └── execution.test.ts
```

**Provider interface (from architecture spec §10):**

```typescript
interface AgentProvider {
  invoke(request: AgentRequest): Promise<AgentResponse>;
  healthCheck(): Promise<HealthStatus>;
  estimateTokens(prompt: string): number;
}
```

**Key behaviors:**

- Each adapter uses **raw `fetch`** with `AbortController` for timeouts. No SDK dependencies.
- `execute()` service:
  1. Looks up agent from registry to get provider + model_id.
  2. Instantiates the correct provider adapter.
  3. Calls `invoke()` with timeout from policy.
  4. On timeout/error: retry up to `policy.max_retries` with exponential backoff (1s, 2s, 4s).
  5. On exhausted retries: return `ExecutionRecord` with `outcome = 'FALLBACK'`.
  6. On success: compute `cost_usd` from token counts × agent cost rates.
  7. Write `execution_log` row.
- Token estimation: `prompt.length / 4` as rough heuristic (same as classifier).

**Acceptance criteria:**

1. Successful invocation → `ExecutionRecord` with `outcome = 'SUCCESS'`, correct token counts and cost.
2. Provider timeout → retry up to `max_retries` → final outcome `TIMEOUT`.
3. Provider 500 error → retry → outcome `ERROR` with `error_detail`.
4. `execution_log` row written with all fields populated.
5. `cost_usd` = `(input_tokens / 1000 * cost_per_1k_input) + (output_tokens / 1000 * cost_per_1k_output)`.
6. `AbortController` aborts fetch after `timeout_ms`.

**Testing strategy:**

- **Unit tests with mocked fetch:** Each provider adapter tested against fixture responses. Mock `globalThis.fetch` to return canned provider responses.
- **Retry logic unit tests:** Mock provider to fail N times then succeed. Verify attempt count.
- **Integration test:** `execution-log` repository writes and reads back correctly from Dolt.
- **No real API calls in CI.** Real provider tests are manual / tagged `@live`.

---

## Story 6: Router Pipeline (Full Lifecycle)

**Goal:** Wire together classification → selection → execution into a single `routeTask(prompt, metadata?)` function that executes the full lifecycle from §3.2 of the architecture spec.

**Dependencies:** Story 3, Story 4, Story 5

**Files to create:**

```
src/
├── router/
│   └── router.ts           # routeTask(input) → TaskResult
├── repositories/
│   └── task-log.ts         # CRUD for task_log: create, updateStatus, updateSelection
├── types/
│   └── router.ts           # TaskInput, TaskResult, TaskStatus enum
tests/
├── router/
│   └── router.test.ts
├── repositories/
│   └── task-log.test.ts
```

**Lifecycle (§3.2):**

1. **Intake:** Assign `task_id`, write to `task_log` with `status = RECEIVED`.
2. **Classify:** Call classifier → update `task_log` with tier, capabilities, cost ceiling. Status → `CLASSIFIED`.
3. **Select:** Call agent selection → update `task_log` with `selected_agent_id` and `selection_rationale`. Status → `DISPATCHED`.
4. **Execute:** Call execution engine → write `execution_log`. Status → `COMPLETED` or `FAILED`.
5. **Commit:** `CALL DOLT_COMMIT(...)` with structured message: `task:<id> | tier:T<n> | agent:<id> | cost:$<x> | <latency>ms`.
6. On failure at any stage: set status to `FAILED`, still commit (for audit trail).

**Fallback handling:**

- If execution returns `outcome = 'FALLBACK'` and `fallback_strategy != 'ABORT'`:
  - Re-run agent selection with adjusted parameters.
  - Execute with the new agent.
  - Record both attempts in `execution_log`.

**Acceptance criteria:**

1. `routeTask("Summarize this text")` → full lifecycle completes, returns response content.
2. `task_log` row shows progression: `RECEIVED → CLASSIFIED → DISPATCHED → COMPLETED`.
3. `execution_log` has one row linked to the task.
4. Dolt log has a structured commit message for the task.
5. Provider failure → fallback agent selected and executed → two `execution_log` rows.
6. All errors caught → status set to `FAILED` → commit still created.

**Testing strategy:**

- Integration test with mocked providers (mock `fetch` to return canned responses).
- Seed 3+ agents with different tiers/capabilities.
- Test happy path, fallback path, and complete failure path.
- Verify Dolt commits via `SELECT * FROM dolt_log LIMIT 1`.

---

## Story 7: Memory Manager (Session Branches)

**Goal:** Implement session-scoped Dolt branches for agent working memory, with context read/write and branch cleanup.

**Dependencies:** Story 6

**Parallelizable with:** Story 8, Story 10

**Files to create:**

```
src/
├── memory/
│   ├── session-manager.ts  # createSession, writeContext, readContext, commitSession, discardSession
│   └── branch-cleanup.ts   # pruneSessionBranches(retentionDays)
├── repositories/
│   ├── session-context.ts  # CRUD for session_context table
│   └── handoff-summary.ts  # CRUD for handoff_summary table
tests/
├── memory/
│   ├── session-manager.test.ts
│   └── branch-cleanup.test.ts
```

**Key behaviors:**

- `createSession(taskId)`:
  1. `CALL DOLT_BRANCH('session/<taskId>')`.
  2. Return session handle with branch name.
- `writeContext(session, key, value)`:
  1. `CALL DOLT_CHECKOUT('session/<taskId>')`.
  2. `INSERT OR REPLACE INTO session_context`.
  3. `CALL DOLT_COMMIT(...)`.
- `readContext(session, key?)`:
  1. `SELECT ... FROM session_context AS OF 'session/<taskId>'` — read without checkout.
- `commitSession(session)`:
  1. `CALL DOLT_CHECKOUT('main')`.
  2. `CALL DOLT_MERGE('session/<taskId>')`.
  3. Prune branch.
- `discardSession(session)`:
  1. `CALL DOLT_CHECKOUT('main')`.
  2. Branch is preserved (not deleted) for debugging. Marked for future cleanup.
- `pruneSessionBranches(retentionDays)`:
  1. Query `dolt_branches` for branches matching `session/*`.
  2. Check commit dates. Delete branches older than retention window.

**Handoff support:**

- `writeHandoffSummary(taskId, fromAgentId, summary)` → writes to `handoff_summary`.
- `readHandoffSummary(taskId)` → reads latest handoff for context assembly.

**Acceptance criteria:**

1. `createSession` → branch appears in `SELECT * FROM dolt_branches`.
2. `writeContext` → data readable from the session branch.
3. `commitSession` → data visible on `main`, branch deleted.
4. `discardSession` → branch preserved, data not on `main`.
5. `pruneSessionBranches(0)` → deletes old merged branches.
6. Handoff summary write + read round-trips correctly.

**Testing strategy:**

- Integration tests against Dolt. Each test creates a unique session branch, operates on it, cleans up.
- Test concurrent sessions (two branches active simultaneously).
- Test merge conflict scenario (two sessions modify same key — expect `--ours` resolution).

---

## Story 8: API Layer (Hono + OpenAPI)

**Goal:** HTTP API exposing task submission, status polling, and agent registry management. OpenAPI spec auto-generated from Zod schemas.

**Dependencies:** Story 6

**Parallelizable with:** Story 7, Story 10

**Files to create:**

```
src/
├── api/
│   ├── app.ts              # Hono app creation, middleware registration
│   ├── middleware/
│   │   ├── error-handler.ts    # Global error → JSON response mapping
│   │   └── request-id.ts       # Attach X-Request-ID header
│   └── routes/
│       ├── tasks.ts         # POST /tasks, GET /tasks/:id
│       ├── agents.ts        # GET /agents, POST /agents, PUT /agents/:id, DELETE /agents/:id
│       └── health.ts        # GET /health (Dolt connectivity check)
├── index.ts                 # Updated: starts Hono server
tests/
├── api/
│   ├── tasks.test.ts
│   ├── agents.test.ts
│   └── health.test.ts
```

**Routes:**

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/tasks` | `routeTask` | Submit a task. Body: `{ prompt, metadata?, constraints? }`. Returns `{ task_id, status }`. |
| `GET` | `/tasks/:id` | read `task_log` | Poll task status. Returns full `task_log` row + `execution_log` if completed. |
| `GET` | `/agents` | `findAll` | List all agents. Query params: `?status=active&capability=code_generation`. |
| `POST` | `/agents` | `create` | Register a new agent. Body: `CreateAgentInput`. |
| `PUT` | `/agents/:id` | `update` | Update agent fields. Body: `UpdateAgentInput`. |
| `DELETE` | `/agents/:id` | `softDelete` | Soft-delete (set status=disabled). |
| `GET` | `/health` | DB ping | Returns `{ status: 'ok', dolt: 'connected' }`. |

**Key decisions:**

- **Hono** with `@hono/zod-openapi` for request/response validation and automatic OpenAPI spec generation.
- All request bodies validated via Zod schemas defined in `src/types/`.
- Error handler maps domain errors to HTTP status codes:
  - `ValidationError` → 400
  - `NotFoundError` → 404
  - `NoAgentAvailableError` → 503
  - Unhandled → 500

**Acceptance criteria:**

1. `POST /tasks` with valid prompt → 201 with `task_id`.
2. `GET /tasks/:id` → returns task with current status.
3. `POST /agents` with valid body → 201. Invalid body → 400 with Zod error details.
4. `GET /agents?capability=code_generation` → filtered list.
5. `DELETE /agents/:id` → 200, agent status now `disabled`.
6. `GET /health` → 200 when Dolt is up, 503 when down.
7. OpenAPI spec available at `/doc` or `/openapi.json`.

**Testing strategy:**

- Use Hono's `app.request()` test helper (in-process, no HTTP server needed).
- Mock the service layer for unit tests.
- Integration tests: full stack with Dolt, exercise happy paths and error cases.

---

## Story 9: CLI Interface

**Goal:** A command-line interface for submitting tasks, managing agents, and inspecting system state.

**Dependencies:** Story 8

**Files to create:**

```
src/
├── cli/
│   ├── index.ts            # Entry point, argument parsing
│   ├── commands/
│   │   ├── task.ts         # haol task "prompt" [--tier N] [--capabilities a,b]
│   │   ├── agents.ts       # haol agents list|add|update|remove
│   │   ├── status.ts       # haol status <task_id>
│   │   └── history.ts      # haol history [--agent X] [--since 1h]
│   └── output.ts           # Formatters: table, json, minimal
├── bin/
│   └── haol.ts             # #!/usr/bin/env node shebang, imports cli/index
tests/
├── cli/
│   ├── task.test.ts
│   ├── agents.test.ts
│   └── status.test.ts
```

**Commands:**

```
haol task "Summarize this document"          Submit a task, print result
haol task "..." --tier 3 --cap reasoning     Override classification
haol status <task_id>                        Show task lifecycle
haol agents list                             Table of all agents
haol agents list --status active             Filtered
haol agents add --interactive                Guided registration
haol agents update <id> --status disabled    Update fields
haol history --last 10                       Recent task history
haol history --agent claude-sonnet-4-5       Filter by agent
```

**Key decisions:**

- Use `parseArgs` from `node:util` (built-in, no dependencies) for argument parsing.
- CLI calls the API (HTTP) — it is a client, not a direct DB consumer. This validates the API and keeps the CLI thin.
- Output formats: `--format table` (default), `--format json`, `--format minimal`.

**Acceptance criteria:**

1. `haol task "hello"` → prints task_id and response.
2. `haol agents list` → table output with all columns.
3. `haol status <id>` → shows lifecycle stages with timestamps.
4. `haol history --last 5` → recent tasks in table format.
5. `--format json` → valid JSON output for all commands.
6. Bad arguments → helpful error message with usage hint.

**Testing strategy:**

- Unit tests: mock HTTP calls (`fetch`), verify output formatting.
- Integration test: start API server, run CLI commands against it, verify output.
- Test error cases: invalid task_id, server unreachable.

---

## Story 10: Observability + Audit Queries

**Goal:** Built-in observability queries exposed via API and CLI, leveraging Dolt's version control for audit trails.

**Dependencies:** Story 6

**Parallelizable with:** Story 7, Story 8

**Files to create:**

```
src/
├── observability/
│   ├── queries.ts          # Canned SQL queries as typed functions
│   └── dashboard.ts        # Aggregate stats computation
├── api/routes/
│   └── observability.ts    # GET /stats, GET /audit/*, GET /diffs/*
tests/
├── observability/
│   ├── queries.test.ts
│   └── dashboard.test.ts
```

**Canned queries (from architecture spec §11.1):**

| Function | Description | Returns |
|----------|-------------|---------|
| `costByAgent(hours)` | Cost per agent over last N hours | `{ agent_id, total_cost, invocations }[]` |
| `costCeilingBreaches()` | Tasks where execution cost exceeded ceiling | `{ task_id, ceiling, actual_cost }[]` |
| `agentRegistryDiff(since)` | Agent registry changes in time window | Dolt diff rows |
| `tasksByTier(hours)` | Task count grouped by complexity tier | `{ tier, count }[]` |
| `avgLatencyByAgent(hours)` | Average latency per agent | `{ agent_id, avg_latency_ms }[]` |
| `failureRate(hours)` | Failure rate per agent | `{ agent_id, total, failures, rate }[]` |
| `commitHistory(limit)` | Recent Dolt commits with parsed messages | `{ hash, message, date, author }[]` |

**API routes:**

| Method | Path | Query Params | Description |
|--------|------|-------------|-------------|
| `GET` | `/stats/cost` | `?hours=24` | Cost breakdown by agent |
| `GET` | `/stats/latency` | `?hours=24` | Latency breakdown by agent |
| `GET` | `/stats/failures` | `?hours=24` | Failure rates |
| `GET` | `/stats/tiers` | `?hours=24` | Task distribution by tier |
| `GET` | `/audit/agents` | `?since=7d` | Agent registry change log |
| `GET` | `/audit/commits` | `?limit=50` | Dolt commit history |

**CLI additions:**

```
haol stats                     Dashboard summary (cost, latency, failures)
haol audit agents --since 7d   Agent registry changes
haol audit commits --last 20   Recent Dolt commits
```

**Acceptance criteria:**

1. `costByAgent(24)` returns correct sums from seeded execution_log data.
2. `costCeilingBreaches()` correctly identifies tasks where cost exceeded ceiling.
3. `agentRegistryDiff('7d')` returns Dolt diff rows for recent changes.
4. All `/stats/*` and `/audit/*` endpoints return valid JSON with correct shapes.
5. `haol stats` prints a formatted dashboard.
6. Queries handle empty data gracefully (return empty arrays, not errors).

**Testing strategy:**

- Integration tests: seed known data into `execution_log` and `task_log`, run queries, assert exact results.
- Test time-window filtering: seed data at known timestamps, verify query boundaries.
- Test Dolt-specific queries: create commits, then query `dolt_log` and `dolt_diff_*`.

---

## Dependency Graph

```
Story 0  (Scaffold + Dolt)
  │
  v
Story 1  (Schema + Migrations)
  │
  ├──────────────┐
  v              v
Story 2        Story 3
(Registry)     (Classifier)
  │    │         │
  │    │    ┌────┘
  │    v    v
  │  Story 4 (Selection)
  │    │
  v    │
Story 5│ (Execution)
  │    │
  └──┬─┘
     v
Story 6  (Router Pipeline)
  │
  ├──────────┬────────────┐
  v          v            v
Story 7    Story 8     Story 10
(Memory)   (API)       (Observability)
             │
             v
           Story 9
           (CLI)
```

## Subsystem Coverage

| Architecture Subsystem | Primary Story | Supporting Stories |
|----------------------|---------------|-------------------|
| **Router** | Story 6 | Story 3 (classification), Story 4 (selection) |
| **Agent Registry** | Story 2 | Story 8 (API CRUD) |
| **Task Classifier** | Story 3 | Story 6 (integration) |
| **Memory Manager** | Story 7 | Story 1 (session tables) |
| **Execution Engine** | Story 5 | Story 6 (integration) |

All 5 subsystems from the architecture spec are covered.

---

## Implementation Log

### Story 0: Project Scaffolding + Dolt Connection — COMPLETE

**Date:** 2026-03-03

**Files created:**

| File | Purpose |
|------|---------|
| `package.json` | Project manifest — `mysql2`, `dotenv`, `typescript`, `vitest`, `tsx` |
| `tsconfig.json` | ES2022 target, NodeNext module resolution, strict mode |
| `vitest.config.ts` | Sequential file execution (`fileParallelism: false`), dotenv setup |
| `.env.example` | Template for Dolt connection vars |
| `.gitignore` | Excludes `node_modules/`, `dist/`, `.env` |
| `src/config.ts` | `loadConfig()` — typed config from env vars with defaults |
| `src/db/connection.ts` | `createPool`, `getPool`, `query`, `execute`, `healthCheck`, `destroy` |
| `src/db/dolt.ts` | `doltCommit`, `doltCheckout`, `doltBranch`, `doltDeleteBranch`, `doltMerge`, `doltActiveBranch` |
| `src/index.ts` | Placeholder entry point — connects to Dolt and logs status |
| `tests/db/connection.test.ts` | 2 tests: SELECT 1, healthCheck |
| `tests/db/dolt.test.ts` | 3 tests: active branch, commit with allow-empty, branch/checkout/merge lifecycle |

**Test results:** 5/5 passing. Tests gracefully skip at runtime if Dolt is unavailable.

**Notes:**

- Dolt server must be running separately (`dolt sql-server --port 3307`). Tests connect via mysql2 pool.
- `vitest.config.ts` uses `fileParallelism: false` because test files share a module-level connection pool singleton.
- `it.skipIf()` evaluates at definition time (before `beforeAll`), so tests use `ctx.skip()` inside the test body for runtime skip based on Dolt availability.
- `execute()` required an explicit cast (`params as (string | number | null)[]`) to satisfy mysql2's `ExecuteValues` type.

### Story 1: Dolt Schema + Migrations — COMPLETE

**Date:** 2026-03-03

**Files created:**

| File | Purpose |
|------|---------|
| `src/db/migrations/001_create_agent_registry.sql` | `agent_registry` table with ENUM status, JSON capabilities |
| `src/db/migrations/002_create_capability_taxonomy.sql` | `capability_taxonomy` table |
| `src/db/migrations/003_create_task_log.sql` | `task_log` table with ENUM status lifecycle |
| `src/db/migrations/004_create_execution_log.sql` | `execution_log` table with ENUM outcome |
| `src/db/migrations/005_create_routing_policy.sql` | `routing_policy` table with ENUM fallback_strategy |
| `src/db/migrations/006_create_session_context.sql` | `session_context` table with composite PK (session_id, key) |
| `src/db/migrations/007_create_handoff_summary.sql` | `handoff_summary` table with composite PK (task_id, from_agent_id) |
| `src/db/migrations/008_seed_capability_taxonomy.sql` | 9 seed rows via INSERT IGNORE |
| `src/db/migrate.ts` | Reads `.sql` files in order, applies them, commits to Dolt |
| `src/db/seed.ts` | Seeds default routing_policy + 4 sample agents |
| `tests/db/migrations.test.ts` | 9 tests: apply, idempotency, table existence, columns, enums, PKs, seed counts |

**Files modified:**

| File | Change |
|------|--------|
| `package.json` | Added `migrate` and `seed` scripts |

**Test results:** 14/14 passing (5 from Story 0 + 9 new).

**Notes:**

- All migrations use `CREATE TABLE IF NOT EXISTS` and `INSERT IGNORE` for idempotency.
- `migrate.ts` catches the Dolt "nothing to commit" error gracefully on re-runs rather than using `allowEmpty`.
- Seed data includes 4 agents across 3 providers (Anthropic, OpenAI, local) with realistic pricing.
- The `haol` database must be created manually before first migration (`CREATE DATABASE haol` via mysql connection).
