# Code Review: HAOL — Findings & Fix Plan

## Context

Comprehensive code review of the HAOL project covering security, error handling, input validation, type safety, concurrency, and test coverage. Findings are organized by severity. The fix plan addresses all HIGH and MEDIUM issues.

---

## Findings Summary

### HIGH Severity

| #   | Issue                                                                                                                                                     | Location                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| H1  | **No authentication/authorization on any API endpoint** — all routes are fully open                                                                       | `src/api/app.ts`, all route files          |
| H2  | **ReDoS via database-stored regex patterns** — `new RegExp(rule.pattern)` on user prompts with no safe-regex validation                                   | `src/cascade-router/cascade-router.ts:215` |
| H3  | **SQL injection via dynamic column names** — `${key} = ?` in UPDATE without column whitelist                                                              | `src/repositories/agent-registry.ts:125`   |
| H4  | **Fallback execution failure unhandled** — `execute()` on line 101 of router.ts can throw, bubbling up past the fallback logic and skipping status update | `src/router/router.ts:101`                 |

### MEDIUM Severity

| #   | Issue                                                                                                       | Location                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| M1  | **No input bounds on query params** — `parseInt()` without NaN/range checks on `hours`, `limit`, `tier`     | `src/api/routes/observability.ts`, `src/cli/index.ts`                                |
| M2  | **No CORS middleware**                                                                                      | `src/api/app.ts`                                                                     |
| M3  | **No rate limiting**                                                                                        | `src/api/app.ts`                                                                     |
| M4  | **No prompt size limit** — `z.string().min(1)` with no max                                                  | `src/router/router.ts:13` (RouterTaskInputSchema)                                    |
| M5  | **Singleton race condition** — concurrent `getInstance()` calls can create multiple CascadeRouter instances | `src/cascade-router/classify.ts:9-44`                                                |
| M6  | **Provider API keys silently default to empty string** — fails at invocation instead of at startup          | `src/providers/anthropic.ts:8`, `src/providers/openai.ts:8`                          |
| M7  | **Routing policy weights not validated** — weights can sum to 0 or exceed 1.0, breaking scoring             | `src/services/agent-selection.ts:93-96`                                              |
| M8  | **Unsafe JSON.parse without try-catch** in repository row parsing                                           | `src/repositories/session-context.ts:22`, `task-log.ts:35,43`, `execution-log.ts:30` |
| M9  | **Cascade router errors silently swallowed** — fallback to old classifier with no logging                   | `src/cascade-router/classify.ts:33-42` and `src/router/router.ts:38`                 |
| M10 | **Unvalidated config values** — port, pool size not bounds-checked                                          | `src/config.ts:28,32`                                                                |

---

## Detailed Analysis

### H1: No Authentication

**Current state:** `src/api/app.ts` registers `requestId` middleware and routes — no auth at all. Any HTTP client can hit `/tasks`, `/agents`, `/observability/*`.

**Risk:** Full read/write access to agent registry, task submission, and observability data.

### H2: ReDoS via Database-Stored Regex

**Current state** (`src/cascade-router/cascade-router.ts:214-215`):

```typescript
case "regex":
  try {
    matched = new RegExp(rule.pattern, "i").test(prompt);
  } catch {
    // Invalid regex — skip
  }
```

Patterns come from `routing_rules` table. A malicious or poorly-written pattern like `(a+)+$` tested against a long input causes catastrophic backtracking, blocking the event loop.

### H3: SQL Injection via Dynamic Column Names

**Current state** (`src/repositories/agent-registry.ts:119-131`):

```typescript
for (const [key, value] of entries) {
  if (value === undefined) continue;
  setClauses.push(`${key} = ?`);  // key is interpolated directly!
  ...
}
```

While `key` comes from `UpdateAgentInput` (typed), at runtime any string passed in the object gets interpolated into SQL without validation. If a caller passes `{"agent_id; DROP TABLE agent_registry; --": "x"}`, it becomes part of the query.

### H4: Fallback Execution Unhandled

**Current state** (`src/router/router.ts:95-106`):

```typescript
if (fallbackSelection) {
  await taskLog.updateSelection(taskId, fallbackSelection.agent_id, { ... });
  execResult = await execute(  // line 101 — can throw!
    fallbackSelection.agent_id,
    agentRequest,
    0,
  );
}
```

If `execute()` throws during fallback (e.g., provider timeout becomes an unhandled error), the exception propagates to the outer catch block. The task gets marked FAILED, but the flow skips the normal status-update logic on lines 109-116 and the commit on lines 119-122. The outer catch does attempt status update and commit, but this is best-effort and may lose context.

### M1: Unvalidated Query Params

**Current state** (`src/api/routes/observability.ts`):

```typescript
const hours = parseInt(c.req.query("hours") ?? "24", 10);
```

- `parseInt("abc")` → `NaN` → passed to SQL `WHERE created_at >= NOW() - INTERVAL ? HOUR` — behavior undefined
- `parseInt("-999")` → negative hours — nonsensical query
- `parseInt("999999")` → extreme range — potential performance issue

Same pattern in `src/cli/index.ts` for `--tier`, `--last`, `--hours`.

### M5: Singleton Race Condition

**Current state** (`src/cascade-router/classify.ts:9-43`):

```typescript
let instance: CascadeRouter | null = null;

async function getInstance(): Promise<CascadeRouter> {
  if (!instance) {
    // ... async initialization ...
    instance = await CascadeRouter.create({ ... });
  }
  return instance;
}
```

Two concurrent requests both see `instance === null`, both start `CascadeRouter.create()`, and the second assignment overwrites the first. Not catastrophic but wastes resources and could cause subtle bugs if initialization has side effects.

### M8: Unsafe JSON.parse

**Locations:**

- `src/repositories/session-context.ts:22`: `JSON.parse(row.value)` — if `value` column contains malformed JSON, this throws and crashes the request
- `src/repositories/task-log.ts:35`: `JSON.parse(row.required_capabilities)` — same risk
- `src/repositories/task-log.ts:43`: `JSON.parse(row.selection_rationale)` — same risk
- `src/repositories/agent-registry.ts:21`: `JSON.parse(row.capabilities)` — same risk (though less likely since the app controls writes)

---

## Fix Plan

### Phase 1: Security (H1, H2, H3, M2, M3)

#### 1a. Add API key authentication middleware (H1)

**Create** `src/api/middleware/auth.ts`:

```typescript
import type { MiddlewareHandler } from "hono";

export const auth: MiddlewareHandler = async (c, next) => {
  const apiKey = process.env.HAOL_API_KEY;
  if (!apiKey) {
    // No key configured — allow (dev mode)
    return next();
  }

  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = header.slice(7);
  if (token !== apiKey) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  return next();
};
```

**Modify** `src/api/app.ts` — register auth middleware on all routes except `/health`:

```typescript
import { auth } from "./middleware/auth.js";
import { cors } from "hono/cors";

// After requestId middleware:
app.use("/tasks/*", auth);
app.use("/agents/*", auth);
app.use("/stats/*", auth);
app.use("/audit/*", auth);
```

#### 1b. Whitelist columns in agent-registry update (H3)

**Modify** `src/repositories/agent-registry.ts:115-141`:

```typescript
const ALLOWED_UPDATE_COLUMNS = new Set<string>([
  "provider",
  "model_id",
  "capabilities",
  "cost_per_1k_input",
  "cost_per_1k_output",
  "max_context_tokens",
  "avg_latency_ms",
  "status",
  "tier_ceiling",
]);

export async function update(agentId: string, fields: UpdateAgentInput): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) continue; // skip unknown columns
    setClauses.push(`${key} = ?`);
    params.push(key === "capabilities" ? JSON.stringify(value) : value);
  }

  if (setClauses.length === 0) return;
  params.push(agentId);
  const pool = getPool();
  await pool.query(`UPDATE agent_registry SET ${setClauses.join(", ")} WHERE agent_id = ?`, params);
}
```

#### 1c. Validate regex patterns before use (H2)

**Modify** `src/cascade-router/cascade-router.ts:212-219`:

Add a helper function:

```typescript
function isSafeRegex(pattern: string): boolean {
  // Reject patterns with nested quantifiers that cause catastrophic backtracking
  // e.g., (a+)+, (a*)*b, (a|b+)+
  return !/(\+|\*|\{)\)?(\+|\*|\{)/.test(pattern) && pattern.length <= 500;
}
```

In the switch case:

```typescript
case "regex":
  try {
    if (!isSafeRegex(rule.pattern)) {
      console.warn(`Skipping unsafe regex pattern: ${rule.pattern.slice(0, 50)}`);
      break;
    }
    matched = new RegExp(rule.pattern, "i").test(prompt);
  } catch {
    // Invalid regex — skip
  }
  break;
```

#### 1d. Add CORS middleware (M2)

**Modify** `src/api/app.ts`:

```typescript
import { cors } from "hono/cors";

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
  }),
);
```

#### 1e. Add rate limiting (M3)

**Create** `src/api/middleware/rate-limit.ts`:

Simple in-memory sliding-window rate limiter:

```typescript
import type { MiddlewareHandler } from "hono";

const windowMs = 60_000;
const maxRequests = parseInt(process.env.RATE_LIMIT_RPM ?? "120", 10);
const hits = new Map<string, number[]>();

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("x-forwarded-for") ?? "unknown";
  const now = Date.now();
  const timestamps = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (timestamps.length >= maxRequests) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return next();
};
```

Register in `app.ts` after CORS, before auth.

---

### Phase 2: Error Handling (H4, M6, M8, M9)

#### 2a. Wrap fallback execution in try-catch (H4)

**Modify** `src/router/router.ts:95-106`:

```typescript
if (fallbackSelection) {
  await taskLog.updateSelection(taskId, fallbackSelection.agent_id, {
    fallback_from: selection.selected_agent_id,
    reason: execResult.outcome,
  });

  try {
    execResult = await execute(fallbackSelection.agent_id, agentRequest, 0);
  } catch (fallbackErr) {
    console.error(`Fallback execution failed: ${(fallbackErr as Error).message}`);
    // Keep the original failed execResult — flow continues to status update
  }
}
```

#### 2b. Fail fast on missing API keys (M6)

**Modify** `src/providers/anthropic.ts:7-9`:

```typescript
constructor(modelId: string) {
  this.apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!this.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for AnthropicProvider");
  }
  this.modelId = modelId;
}
```

**Modify** `src/providers/openai.ts:7-9` — same pattern with `OPENAI_API_KEY`.

#### 2c. Safe JSON.parse in repositories (M8)

**Modify** `src/repositories/session-context.ts:22`:

```typescript
function safeJsonParse(raw: string, fallback: unknown = raw): unknown {
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

// In parseRow:
value: typeof row.value === "string" ? safeJsonParse(row.value) : row.value,
```

**Modify** `src/repositories/task-log.ts:33-45` — wrap both `JSON.parse` calls:

```typescript
capabilities =
  typeof row.required_capabilities === "string"
    ? (safeJsonParse(row.required_capabilities, []) as string[])
    : row.required_capabilities;

rationale =
  typeof row.selection_rationale === "string"
    ? (safeJsonParse(row.selection_rationale, {}) as Record<string, unknown>)
    : (row.selection_rationale as Record<string, unknown>);
```

**Modify** `src/repositories/agent-registry.ts:21` — same pattern for `capabilities`.

#### 2d. Log cascade router fallback (M9)

**Modify** `src/router/router.ts:38-42`:

```typescript
} catch (cascadeErr) {
  console.warn(`Cascade router unavailable, falling back to old classifier: ${(cascadeErr as Error).message}`);
  classification = classify({
    prompt: parsed.prompt,
    metadata: parsed.metadata,
  });
}
```

**Modify** `src/cascade-router/classify.ts:23-25` (embedding provider catch):

```typescript
} catch (err) {
  console.warn(`Embedding provider unavailable: ${(err as Error).message}`);
}
```

And lines 34-36 (escalation provider catch):

```typescript
} catch (err) {
  console.warn(`Escalation provider unavailable: ${(err as Error).message}`);
}
```

---

### Phase 3: Input Validation (M1, M4, M7, M10)

#### 3a. Validate and clamp query parameters (M1)

**Modify** `src/api/routes/observability.ts` — add helper and apply:

```typescript
function parseIntClamped(
  val: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(val ?? String(defaultVal), 10);
  if (isNaN(parsed)) return defaultVal;
  return Math.max(min, Math.min(max, parsed));
}

// Usage:
const hours = parseIntClamped(c.req.query("hours"), 24, 1, 720);
const limit = parseIntClamped(c.req.query("limit"), 50, 1, 1000);
```

**Modify** `src/cli/index.ts` — same for `--tier` (1-4), `--hours` (1-720), `--last` (1-1000):

```typescript
const tier = values.tier ? parseIntClamped(values.tier as string, undefined, 1, 4) : undefined;
const hours = values.hours ? parseIntClamped(values.hours as string, 24, 1, 720) : undefined;
const last = values.last ? parseIntClamped(values.last as string, 20, 1, 1000) : undefined;
```

#### 3b. Add prompt max length (M4)

**Modify** `src/router/router.ts` — find the `RouterTaskInputSchema` (likely in `src/types/router.ts`):

```typescript
prompt: z.string().min(1).max(100_000),
```

#### 3c. Validate routing policy weights (M7)

**Modify** `src/services/agent-selection.ts` — after loading policy in `select()`:

```typescript
// Normalize weights if they don't sum to ~1.0
const weightSum = policy.weight_capability + policy.weight_cost + policy.weight_latency;
if (weightSum <= 0) {
  throw new Error("Routing policy weights sum to zero or negative");
}
if (Math.abs(weightSum - 1.0) > 0.01) {
  policy = {
    ...policy,
    weight_capability: policy.weight_capability / weightSum,
    weight_cost: policy.weight_cost / weightSum,
    weight_latency: policy.weight_latency / weightSum,
  };
}
```

#### 3d. Validate config at startup (M10)

**Modify** `src/config.ts:24-35`:

```typescript
export function loadConfig(): Config {
  const port = parseInt(requireEnv("DOLT_PORT", "3306"), 10);
  const poolSize = parseInt(requireEnv("DOLT_POOL_SIZE", "5"), 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DOLT_PORT: must be 1-65535`);
  }
  if (isNaN(poolSize) || poolSize < 1 || poolSize > 100) {
    throw new Error(`Invalid DOLT_POOL_SIZE: must be 1-100`);
  }

  return {
    dolt: {
      host: requireEnv("DOLT_HOST", "127.0.0.1"),
      port,
      user: requireEnv("DOLT_USER", "root"),
      password: requireEnv("DOLT_PASSWORD", ""),
      database: requireEnv("DOLT_DATABASE", "haol"),
      poolSize,
    },
  };
}
```

---

### Phase 4: Concurrency (M5)

#### 4a. Fix singleton race condition

**Modify** `src/cascade-router/classify.ts:7-44`:

```typescript
let instancePromise: Promise<CascadeRouter> | null = null;

async function createInstance(): Promise<CascadeRouter> {
  const rules = await store.loadRules();
  const hasEmbed = await store.hasEmbeddings();
  if (rules.length === 0 && !hasEmbed) {
    throw new Error("Cascade router not seeded — falling back to old classifier");
  }

  const config = await store.loadConfig();

  let embeddingProvider;
  try {
    embeddingProvider = createEmbeddingProvider(config);
  } catch (err) {
    console.warn(`Embedding provider unavailable: ${(err as Error).message}`);
  }

  let escalationProvider;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      escalationProvider = new AnthropicEscalationProvider({
        modelId: config.escalation_model,
      });
    }
  } catch (err) {
    console.warn(`Escalation provider unavailable: ${(err as Error).message}`);
  }

  return CascadeRouter.create({ embeddingProvider, escalationProvider });
}

async function getInstance(): Promise<CascadeRouter> {
  if (!instancePromise) {
    instancePromise = createInstance();
  }
  return instancePromise;
}

export function resetCascadeRouter(): void {
  instancePromise = null;
}
```

By storing the **promise** instead of the resolved instance, concurrent callers all await the same initialization.

---

## Files to Modify

| File                                   | Changes                                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| `src/api/app.ts`                       | Add CORS, rate-limit, auth middleware                        |
| `src/api/middleware/auth.ts`           | **New** — Bearer token auth middleware                       |
| `src/api/middleware/rate-limit.ts`     | **New** — in-memory rate limiter                             |
| `src/api/routes/observability.ts`      | Add `parseIntClamped` for `hours`/`limit` params             |
| `src/cascade-router/cascade-router.ts` | Add `isSafeRegex()` guard before `new RegExp()`              |
| `src/cascade-router/classify.ts`       | Fix singleton race (promise-based), add warn logs            |
| `src/cli/index.ts`                     | Clamp `--tier`, `--hours`, `--last` params                   |
| `src/config.ts`                        | Validate port (1-65535) and poolSize (1-100)                 |
| `src/providers/anthropic.ts`           | Throw if `ANTHROPIC_API_KEY` missing                         |
| `src/providers/openai.ts`              | Throw if `OPENAI_API_KEY` missing                            |
| `src/repositories/agent-registry.ts`   | Add `ALLOWED_UPDATE_COLUMNS` whitelist, safe JSON.parse      |
| `src/repositories/session-context.ts`  | Wrap `JSON.parse` in try-catch                               |
| `src/repositories/task-log.ts`         | Wrap both `JSON.parse` calls in try-catch                    |
| `src/router/router.ts`                 | Wrap fallback `execute()` in try-catch, log cascade fallback |
| `src/services/agent-selection.ts`      | Validate/normalize policy weights                            |
| `src/types/router.ts`                  | Add `.max(100_000)` to prompt schema                         |

## Verification

1. `npm run build` — no type errors
2. `npm run test` — all existing tests pass
3. Manual tests:
   - API call without auth header returns 401
   - `hours=abc` and `hours=999999` are clamped correctly
   - Agent update with injected column name is rejected
   - Prompt over 100KB is rejected with 400
4. Targeted tests to add:
   - Auth middleware (valid key, missing key, wrong key)
   - `parseIntClamped` helper
   - `isSafeRegex` function
   - Column whitelist rejection
   - Weight normalization
