# Outcome Capture for Routing Feedback

## Context

HAOL routes tasks to agents but has no structured way to learn from results. The execution_log captures whether calls succeeded or failed, but there's no system for: verifying output quality, evaluating routing confidence, or receiving downstream ground-truth signals. This feature adds a 4-tier feedback taxonomy — from free structural signals to delayed downstream consumption signals — with a `task_outcome` table and `POST /tasks/:id/outcome` API that wires these signals back to the router.

## Key Architectural Insight

The cascade router already computes `confidence` (0-1) and `layer` (deterministic/semantic/escalation/fallback) per classification, but these values are only logged to `routing_log` — they're not on `TaskClassification` and not available to the router pipeline. Bridging this gap is prerequisite to Tier 2 sampling.

---

## Schema Changes

### Migration 010: `task_outcome` table

```sql
CREATE TABLE IF NOT EXISTS task_outcome (
  outcome_id    VARCHAR(36)   PRIMARY KEY,
  task_id       VARCHAR(36)   NOT NULL,
  tier          TINYINT       NOT NULL,         -- 0, 1, 2, 3
  source        VARCHAR(64)   NOT NULL,         -- pipeline, format_check, routing_eval, downstream
  signal_type   VARCHAR(64)   NOT NULL,         -- e.g. fallback_activated, json_valid, tier_plausible
  signal_value  TINYINT       NOT NULL,         -- 1 = positive, 0 = negative
  confidence    FLOAT         DEFAULT NULL,     -- routing confidence at decision time
  detail        JSON          DEFAULT NULL,     -- tier-specific payload
  reported_by   VARCHAR(128)  DEFAULT NULL,     -- tier 3: reporting system
  created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_outcome_task (task_id),
  KEY idx_outcome_tier (tier),
  KEY idx_outcome_signal (signal_type),
  KEY idx_outcome_created (created_at)
);
```

Single table for all tiers. `tier` + `signal_type` discriminate. Binary `signal_value` across all tiers — consistent with the user's design (Tier 2 is explicitly "binary signal").

### Migration 011: Add routing confidence to `task_log`

```sql
ALTER TABLE task_log ADD COLUMN routing_confidence FLOAT DEFAULT NULL;
ALTER TABLE task_log ADD COLUMN routing_layer VARCHAR(32) DEFAULT NULL;
```

### Migration 012: Add `expected_format` to `task_log`

```sql
ALTER TABLE task_log ADD COLUMN expected_format JSON DEFAULT NULL;
```

For Tier 1 format verification — tasks declare what structure they expect.

### Migration 013: Add `weight_outcome` to `routing_policy`

```sql
ALTER TABLE routing_policy ADD COLUMN weight_outcome DECIMAL(3,2) DEFAULT 0.00;
```

Defaults to 0 — data collection begins immediately, routing influence is opt-in.

---

## Type Definitions

### New: `src/types/outcome.ts`

- `OutcomeTier` — `0 | 1 | 2 | 3`
- `OutcomeSource` — `"pipeline" | "format_check" | "routing_eval" | "downstream"`
- `TaskOutcomeRecord` — full row schema (Zod)
- `DownstreamOutcomeInput` — POST body for Tier 3: `{ signal_type, signal_value, reported_by, detail? }`
- `FormatSpec` — `{ type?, max_length?, min_length?, required_fields? }`
- `OutcomeSummary` — aggregated read view across all tiers

### Modify: `src/types/task.ts`

Add optional fields to `TaskClassification`:
- `routing_confidence: z.number().optional()`
- `routing_layer: z.string().optional()`

### Modify: `src/types/router.ts`

Add `expected_format` (optional FormatSpec) to `RouterTaskInput`.

### Modify: `src/types/selection.ts`

Add `weight_outcome: z.number().default(0)` to `RoutingPolicy`.

---

## Data Layer

### New: `src/repositories/task-outcome.ts`

Following existing repo patterns (parameterized queries, `parseRow`, JSON handling):
- `insert(record)` — single outcome row
- `insertBatch(records)` — for Tier 0 (multiple signals at once)
- `findByTaskId(taskId)` — all outcomes for a task
- `findByTaskIdAndTier(taskId, tier)` — filtered
- `findLowConfidenceTasks(threshold, hours, limit)` — for Tier 2 sampling (joins task_log)

### Modify: `src/repositories/task-log.ts`

- `updateRoutingConfidence(taskId, confidence, layer)` — stores cascade router confidence
- `updateExpectedFormat(taskId, formatSpec)` — stores format spec
- Extend `TaskLogRow` / `TaskLogRecord` / `parseRow` for new columns

---

## Outcome Collection Service

### New: `src/services/outcome-collector.ts`

#### Tier 0: `collectStructuralSignals(taskId, execRecords, taskRecord, constraints)`

Computed from data already in memory at end of pipeline — zero extra DB reads. Signals:

| Signal | Source | Logic |
|--------|--------|-------|
| `fallback_activated` | selection_rationale | Has `fallback_from` key |
| `error_occurred` | execRecords | Any outcome = ERROR |
| `timeout_occurred` | execRecords | Any outcome = TIMEOUT |
| `token_budget_overrun` | execRecords + constraints | output_tokens >= max_tokens |
| `cost_ceiling_breach` | execRecords + taskRecord | sum(cost_usd) > cost_ceiling_usd |
| `latency_anomaly` | execRecords + agent registry | latency_ms > 3x agent.avg_latency_ms (requires one agent lookup) |

Each becomes a `TaskOutcomeRecord` with `tier: 0, source: "pipeline"`. Written via `insertBatch`.

#### Tier 1: `runFormatVerification(taskId, responseContent, formatSpec)`

Only runs if `expected_format` was provided and execution succeeded. Programmatic checks:
- `json_valid` — `JSON.parse()` succeeds
- `required_fields_present` — parsed object has all required fields
- `length_within_bounds` — content.length vs max_length/min_length

Written via `insertBatch`.

#### Tier 2: `shouldSampleForEvaluation(confidence)` + `evaluateRoutingDecision(taskId)`

`shouldSampleForEvaluation` — static threshold initially (confidence < 0.6). Returns boolean.

`evaluateRoutingDecision` — async, fire-and-forget from router:
1. Load task record (prompt, tier, capabilities)
2. Call a fast model via existing escalation provider with structured prompt: "Given this prompt, is Tier X assignment plausible? YES or NO"
3. Insert single Tier 2 row: `signal_type: "tier_assignment_plausible"`, `signal_value: 1 or 0`
4. Dolt commit

#### Tier 3: `recordDownstreamOutcome(taskId, input)`

Called from API endpoint. Validates task exists, inserts row with `tier: 3, source: "downstream"`, Dolt commits.

---

## Router Integration

### Modify: `src/cascade-router/cascade-router.ts` (line 177)

The `classify` method already has `confidence` and `layer` in scope. Add them to the returned `TaskClassification`:

```typescript
return {
  task_id: taskId,
  complexity_tier: tier,
  required_capabilities: [...allCapabilities],
  cost_ceiling_usd: costCeilingForTier(tier),
  prompt_hash: sha256(prompt),
  routing_confidence: confidence,   // NEW
  routing_layer: layer,             // NEW
};
```

### Modify: `src/router/router.ts`

Three additions after existing pipeline steps:

1. **After classification** (line 44): Store confidence on task_log
   ```
   if (classification.routing_confidence != null) {
     await taskLog.updateRoutingConfidence(taskId, classification.routing_confidence, classification.routing_layer);
   }
   ```

2. **After intake** (line 48): Store expected_format if provided
   ```
   if (parsed.expected_format) {
     await taskLog.updateExpectedFormat(taskId, parsed.expected_format);
   }
   ```

3. **After status update, before Dolt commit** (between lines 112-114): Collect outcomes
   ```
   // Best-effort outcome collection — never fails the task
   try {
     const execRecords = await execRepo.findByTaskId(taskId);
     await collectStructuralSignals(taskId, execRecords, taskRecord, agentRequest.constraints);

     if (parsed.expected_format && execResult.response_content) {
       await runFormatVerification(taskId, execResult.response_content, parsed.expected_format);
     }

     if (classification.routing_confidence != null
         && shouldSampleForEvaluation(classification.routing_confidence)) {
       evaluateRoutingDecision(taskId).catch(() => {}); // fire-and-forget
     }
   } catch { /* best-effort */ }
   ```

---

## API Endpoints

### New: `src/api/routes/outcomes.ts`

**`POST /tasks/:id/outcome`** — Tier 3 downstream signal
- Body: `DownstreamOutcomeInput` (Zod validated)
- Validates task exists via `taskLog.findById`
- Inserts outcome, Dolt commits
- Returns 201 with created record

**`GET /tasks/:id/outcomes`** — All outcome signals for a task
- Optional `?tier=0` filter
- Returns `TaskOutcomeRecord[]`

**`GET /tasks/:id/outcomes/summary`** — Aggregated `OutcomeSummary`
- Reads all outcome rows, assembles in code

### Modify: `src/api/app.ts`

Mount: `app.route("/", outcomes);`

---

## Observability

### Modify: `src/observability/queries.ts`

- `outcomeSignalRates(hours)` — pass/fail rates per signal_type
- `routingAccuracyByAgent(hours)` — per-agent positive outcome rate from Tier 2+3

### Modify: `src/api/routes/observability.ts`

- `GET /stats/outcomes?hours=24` — signal rates
- `GET /stats/routing-accuracy?hours=24` — per-agent accuracy

---

## Feedback Loop (Phase 7 — can ship separately)

### Modify: `src/services/agent-selection.ts`

Add `outcome_score` to the scoring formula:
- Query recent outcome data per candidate agent (AVG of signal_value from Tier 1-3, last 72h)
- New total: `cap * w_cap + cost * w_cost + latency * w_lat + outcome * w_outcome`
- With `weight_outcome` at 0.0 by default, this is inert until an operator enables it

---

## Implementation Order

| Phase | Files | What |
|-------|-------|------|
| 1 | Migrations 010-013, types | Schema + types, no behavior change |
| 2 | `task-outcome.ts` repo, `task-log.ts` updates | Data layer |
| 3 | `outcome-collector.ts`, cascade-router return | Collection logic |
| 4 | `router.ts` | Wire collection into pipeline |
| 5 | `outcomes.ts` route, `app.ts` | API endpoints |
| 6 | `queries.ts`, `observability.ts` | Observability |
| 7 | `agent-selection.ts` | Feedback loop (deferrable) |
| 8 | Tests | Repo, service, API tests |

---

## Files to Create

- `src/db/migrations/010_create_task_outcome.sql`
- `src/db/migrations/011_add_routing_confidence_to_task_log.sql`
- `src/db/migrations/012_add_format_spec_to_task_log.sql`
- `src/db/migrations/013_add_outcome_weight_to_routing_policy.sql`
- `src/types/outcome.ts`
- `src/repositories/task-outcome.ts`
- `src/services/outcome-collector.ts`
- `src/api/routes/outcomes.ts`
- `tests/repositories/task-outcome.test.ts`
- `tests/services/outcome-collector.test.ts`
- `tests/api/outcomes.test.ts`

## Files to Modify

- `src/types/task.ts` — add routing_confidence, routing_layer to TaskClassification
- `src/types/router.ts` — add expected_format to RouterTaskInput
- `src/types/selection.ts` — add weight_outcome to RoutingPolicy
- `src/repositories/task-log.ts` — new columns, updateRoutingConfidence, updateExpectedFormat
- `src/cascade-router/cascade-router.ts` — return confidence + layer on TaskClassification
- `src/router/router.ts` — wire outcome collection after execution
- `src/api/app.ts` — mount outcomes route
- `src/observability/queries.ts` — outcome queries
- `src/api/routes/observability.ts` — outcome stats routes
- `src/services/agent-selection.ts` — outcome_score factor (Phase 7)

---

## Verification

1. `npm run migrate` — apply new migrations
2. `npm run build` — confirm TypeScript compiles
3. `npm run test` — existing tests still pass
4. Submit a task via `POST /tasks` and verify:
   - Tier 0 signals written to `task_outcome`
   - `routing_confidence` populated on `task_log`
5. Submit task with `expected_format` and verify Tier 1 signals
6. Call `POST /tasks/{id}/outcome` with downstream signal, verify Tier 3 row + Dolt commit
7. Check `GET /tasks/{id}/outcomes/summary` returns aggregated view
8. Check `GET /stats/outcomes` returns signal rates
