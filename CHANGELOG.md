# Changelog

All notable changes to the HAOL (Heterogeneous Agent Orchestration Layer) project are documented in this file.

## [Unreleased]

### Changed

- **`withBranchConnection` no longer resets autocommit + branch on every release** (#78) — The helper's cleanup previously ran an unconditional `SET @@autocommit = 1` and `DOLT_CHECKOUT main` on every release — two round-trips per memory step (~40 extra queries per task at concurrency 4 / ~5 steps). It now tracks per-connection state (via `doltCheckout`/the new `setAutocommit` helper) and skips a reset when the callback already left the connection clean, which the memory paths always do. Untracked connections still reset conservatively, so the branch-safety invariant is unchanged. No behavior change for callers.
- **Observability time windows are now capped at 90 days** (#74) — All `/v1/observability/*` endpoints that accept a time window (the `hours` query param and the `since` duration string on `/audit/agents`) now clamp to `MAX_WINDOW_HOURS` (2160 hours / 90 days). This bounds the worst-case scan for the `dolt_log` date scans (which cannot be indexed) and the `routing_log` near-miss query. **Behavior change for API consumers:** a request for `hours` greater than 2160 returns data for exactly 2160 hours instead of erroring — the clamping is silent, but the response echoes the effective `window_hours` so callers can detect it.

## [v0.7.0] — 2026-06-06

A hardening release: audit-driven correctness fixes across the async task pipeline and API validation surface, plus security-driven dependency bumps. No breaking changes.

### Added

- **Strict input validation on the API boundary** — New `src/api/request-body.ts` `parseJsonBody()` helper turns malformed JSON into a clean `400 ValidationError` instead of an unhandled exception; adopted across the `/tasks`, `/agents`, `/demo`, and `/outcomes` routes. Agent create/update inputs now enforce a closed `AgentProvider` enum (`anthropic`/`openai`/`local`), non-negative costs, positive-integer context windows, and `tier_ceiling` in 1–4. Task `constraints` are bounded (`max_tokens` 1–8192, `timeout_ms` 1000–120000, `temperature` 0–1). Read schemas are deliberately kept wider than write schemas so pre-existing DB rows (e.g. legacy providers) still deserialize instead of crashing.
- **`WORKER_REQUEUE_PAGE_SIZE` env var** — Controls the page size for the reaper's startup re-enqueue of `QUEUED` rows (default 100).

### Fixed

- **Boot-time OOM in the reaper** (#16) — Startup re-enqueue replaced the unbounded `findQueued()` (which loaded the entire backlog, including every row's `prompt` LONGTEXT, into memory at once) with keyset-paged `findQueuedPage()` ordered by `(created_at, task_id)`. The reaper now drains the backlog page-by-page and stops early once the worker can't accept more, bounding peak memory under a boot-time surge of large prompts. Backed by the `idx_task_log_status_created` index from migration 019.
- **Worker tracked-set leak / unhandled rejection** (#13) — Added a defensive `.catch()` on the `runJob` chain in `task-worker.ts` so a synchronous throw in the job body can't strand a task ID in the in-memory `tracked` set or surface as an unhandled promise rejection. The `.finally()` cleanup (`inflight--`, `tracked.delete`) is now guaranteed to run.
- **Unsafe non-null assertions removed** (#11) — `cascade-router.ts` now uses a discriminated `EscalationOutcome` type so `tier`/`confidence` are statically known to be present when an escalation resolves, and `load()` returns the loaded state instead of relying on `this.state!`. `execution.ts` validates `maxRetries` up front and replaces the `lastRecord!` return with a typed exhaustiveness guard.
- **Task intake no longer leaves hidden recoverable work** — On `POST /tasks`, an enqueue failure now attempts to mark the persisted row `FAILED` and returns the `task_id` plus its final status so the caller can poll or discard, rather than silently leaving a `QUEUED` row that could execute later and double-spend provider calls. Queue-full responses now return `429 Too Many Requests` (with `Retry-After`) instead of `503`.
- **Capability validation on update** — `updateAgent` now validates capabilities against the taxonomy (previously create-only), and capability failures raise a typed `CapabilityValidationError` that the API maps to `400` instead of a generic `500`. Unrecognized providers on read are logged as a warning rather than failing the row.

### Dependencies

- **hono** `^4.12.7` → `^4.12.21` — clears Dependabot alerts #14–17.
- **vitest** `^2.1.0` → `^4.1.0` — clears Dependabot alerts #9, #12, #13 (major-version upgrade).

## [v0.6.0] — 2026-05-07

Async task execution, versioned API, live memory layer, and structured logging — plus a long tail of audit-driven correctness fixes.

### Breaking changes

- **`POST /tasks` is now asynchronous** (#50) — Returns `202 Accepted` with `{ task_id, status: "QUEUED", links.self }` and a `Location` header instead of blocking until completion. Clients must poll `GET /tasks/:id` until `done: true`. The previous synchronous response shape is gone.
- **All API routes mount under `/v1`** (#52) — Existing paths (`/tasks`, `/agents`, `/observability/*`, `/health`) move to `/v1/tasks`, `/v1/agents`, `/v1/observability/*`, `/v1/health`. Unversioned URLs no longer resolve. Future breaking changes will get their own version prefix rather than mutating `/v1`.

### Added

- **Async task execution pipeline** (#50) — `POST /tasks` validates input, inserts a `task_log` row in `QUEUED` status, hands the job to an in-process worker (`src/services/task-worker.ts`), and returns `202` immediately. The worker drains the queue with bounded concurrency controlled by `WORKER_CONCURRENCY`. New reaper (`src/services/task-reaper.ts`) re-enqueues stranded `QUEUED` rows on crash and marks rows stuck in `RECEIVED/CLASSIFIED/DISPATCHED` past `WORKER_RECOVERY_AGE_MS` as `FAILED` with `worker_error="worker_crashed"`. Includes in-process enqueue dedup (DB gate alone races on Dolt), atomic terminal-status writes so a partial crash can't leave half-written rows, queue cap with backpressure, error propagation through the poll endpoint, and shutdown await for in-flight work. New migrations: `019_async_task_pipeline.sql` (adds queue/worker columns to `task_log`) and `020_fix_signal_value_nullable.sql`.
- **Memory layer wired into the router lifecycle** (#54) — The architecture documented in CLAUDE.md is now live. After classification, the router opens a `session/{taskId}` Dolt branch, writes structural context (classification, selection, execution records) to `session_context` on that branch, and merges to main on `SUCCESS`. On `FAILED` the branch is preserved for forensics and pruned by the reaper after `SESSION_BRANCH_RETENTION_DAYS` (default 7). All memory work is bounded by an aggregate budget and remains best-effort — Dolt branching outages log a warning but never fail the task. Includes durability semantics made explicit (rather than implicit), pre-merge flush gated on `dolt_status` (no-op when nothing to commit), and centralized autocommit reset.
- **API versioning under `/v1`** (#52) — Stable contract for downstream consumers; the unversioned root is no longer mounted.
- **Structured logging with request correlation** (#53) — JSON logger in `src/logging/` with `request_id` propagated through Hono context. Hono `Variables` are now typed so `c.get` is no longer an unsafe cast. Shared `tests/helpers/capture-stream.ts` for log assertions.
- **Migration tracking with SHA pinning** (#51) — Applied migrations are recorded in `schema_migrations` with a SHA-256 of their content; renamed or edited migration files are detected on next startup. Atomic backfill path for existing deployments, deduped SHA computation, and a warning (not an error) when a tracked migration is missing on disk. The atomicity gap between recording and applying is documented inline.
- **Demo route gating** (#55) — `HAOL_ENABLE_DEMO=true` is now required to mount `/demo` and the static frontend. `serveStatic` is GET-scoped and prompt length is clamped at the demo route boundary.

### Fixed

- **Idempotent / crash-recoverable migrations** (#64) — Migration runner now tolerates partial application (a crash mid-statement no longer wedges the database). Replaced the naïve `split(';')` with a quote-aware splitter that handles single quotes, double quotes, and backticks correctly, so SQL containing semicolons inside string literals or quoted identifiers no longer gets mangled. Companion test file `tests/db/migrate-idempotent.test.ts` covers the recovery path.
- **Fallback now honors `fallback_strategy`** (#63) — `tryFallbackAgent` previously selected the next agent unconditionally regardless of the configured policy. It now respects `NEXT_BEST` (next scored candidate), `TIER_UP` (escalate one tier with explicit telemetry on success and on fallthrough when no higher tier exists), and `ABORT` (explicit guard, no further attempts). Field names aligned across warning logs; `scored_candidates` ordering is documented; coverage added for undefined-policy and T4-with-no-alternative.
- **Fast-fail providers on missing API keys** (#62) — Anthropic and OpenAI provider constructors throw immediately when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is missing, instead of producing cryptic 401s mid-task once a real request is dispatched (audit #12). Local provider remains key-free.
- **No empty router commits** (#61) — Dropped `allowEmpty` from `routerCommit` (audit #15). Empty Dolt commits no longer pollute the audit log when the router has nothing to record.
- **Active-task branch guard in cleanup** (#60) — Branch cleanup queries `task_log` for in-flight tasks before pruning; session branches belonging to active tasks are now retained even if older than the retention threshold. On active-task lookup failure, the cleanup is fail-safe (preserves rather than prunes) so a transient query error can't destroy live session state.
- **Provider error sanitization** (#59) — New `src/providers/error-sanitizer.ts` scrubs auth headers, bearer tokens, and other sensitive fields out of provider error bodies before they're written to `execution_log` and committed to Dolt. Prevents secrets and PII from bleeding into commit history (which, by design, is permanent and auditable).
- **Memory pool stability and flaky-test root cause** (#58) — Forces `autocommit=1` on every new pool connection, closing the `--no-auto-commit` + `REPEATABLE READ` interaction that caused tests to see stale rows depending on connection reuse. Caps memory-layer concurrency to bound pool exhaustion when Dolt is slow (the memory wiring can otherwise hold many connections during long branch operations).
- **Dolt commit attribution** (#57) — Main-branch merges from session branches are now serialized via `GET_LOCK` advisory lock so concurrent merges don't interleave and produce ambiguous commit graphs. Memory commits stage only memory tables (`session_context`, etc.) so unrelated working-tree changes can't leak into a memory commit and confuse the audit trail.
- **Reaper aging from `worker_started_at`** (#56) — Stale-task age is now computed from when the worker actually picked up the task, not when it was queued. Backlogged-but-not-yet-started rows are no longer falsely marked `FAILED` when the queue depth grows past `WORKER_RECOVERY_AGE_MS`.
- **Demo dependencies** (#55) — Patched moderate CVEs in transitive demo dependencies.

### Migration guide (0.5.x → 0.6.0)

1. **Update API base URL** to include `/v1` (e.g., `https://haol.example.com/tasks` → `https://haol.example.com/v1/tasks`).
2. **Update task submission flow** for async semantics: read `task_id` from the `202` body or `Location` header, then poll `GET /v1/tasks/:id` until the response includes `done: true`.
3. **Run `npm run migrate`** to apply migrations 019 and 020 and backfill `schema_migrations` SHAs for existing migrations.
4. **Optional new env vars**:
   - `WORKER_CONCURRENCY` — bounded concurrency for the in-process worker
   - `WORKER_RECOVERY_AGE_MS` — age at which stranded `RECEIVED/CLASSIFIED/DISPATCHED` rows are marked failed
   - `SESSION_BRANCH_RETENTION_DAYS` — how long failed-task session branches are kept (default 7)
   - `HAOL_ENABLE_DEMO` — must be `true` to mount the demo routes

## [v0.5.0] — 2026-05-02

Routing-brain observability, security middleware coverage, synthetic regression gating, and a meaningful reduction in T3 over-escalation.

### Added

- **Cascade router observability** (#48) — New `GET /observability/cascade` endpoint surfacing per-layer hit-rate, tier distribution, latency p50/p95/p99 (overall and per-layer), confidence and similarity-score distributions, and the top 20 near-miss decisions sorted by `similarity_score DESC` (the most informative samples for tuning `similarity_threshold`). Companion `GET /observability/cascade/timeseries` returns bucketed `escalation_rate`, `fallback_rate`, total volume, and `avg_latency_ms` over time. Pairs naturally with the load test: synthetic regressions in CI, real-traffic drift via the endpoint. Includes `snapshot_at` + `consistency: "best_effort"` to make the deliberate read-skew across the 4 underlying queries visible to consumers, and an opt-in `?include_text=true` query param so near-miss prompts default to a SHA-256 hash rather than raw text (defense-in-depth even though the route is auth-gated).
- **Load test harness with CI threshold gates** (#46) — `scripts/load-test.ts` (`npm run load-test`) submits 23 scenarios spanning T1–T4 plus edge cases against a running HAOL server, computing p50/p95/p99 percentiles, per-tier breakdowns, and routing-assertion mismatches. `--json` emits a machine-readable summary; `--max-p95-latency-ms`, `--max-cost-usd`, and `--max-failure-rate` flags exit non-zero on threshold violation. New `.github/workflows/load-test.yml` provisions Dolt, seeds, starts the server, runs the load test against real LLM providers, and posts the report to the job summary. Manual `workflow_dispatch` trigger by default (calls real LLM APIs and costs real money); commented-out schedule block included for opting into nightly runs.
- **Contract tests for security middleware** (#47) — 40 new tests (~500ms, no Dolt dependency) covering the four middleware modules under `src/api/middleware/` that previously had **zero direct test coverage**. Includes `validateApiKeyConfig`'s production-exit path via `vi.resetModules()` + dynamic import, rate-limit token bucket math under fake timers (refill, pruning, per-IP isolation, global mode), error-handler exception-to-status mapping with explicit assertions that sensitive SQL error strings and internal messages don't leak through, and request-id sanitization edge cases.

### Fixed

- **T3 over-escalation** (#49) — Two fixes that together reduced T3 share from 60.9% to 47.8% in the load test (cost ↓ 7%):
  - **Priority short-circuit** (`cascade-router.ts`) — `runDeterministicRules` previously picked `max(tier)` across all matched rules, silently ignoring `routing_rules.priority`. Any incidental T3 keyword in a prompt's data ("the analysis showed...", "extract from this function spec") would clobber a clear T1/T2 match. Switched to first-match-by-priority for tier; capabilities still aggregate across all matched rules. Defensive sort at the top of the function so any alternate call path can't silently break the priority logic.
  - **Intent-based regex tightening** (migration 018, `seed.ts`, `classifier/rules.ts`) — `rule-code` now requires either a strong code verb (implement / debug / refactor / optimize) alone or a generic verb (write / build / create / generate / define / fix) followed by a code-noun within ~40 chars. `rule-reasoning` matches verb forms only (drops "analysis", "comparison", "evaluation"). `rule-tooluse` requires a phrase match or an action verb + tool noun. Both `src/classifier/rules.ts` and `src/db/seed.ts` are kept aligned since the cascade router pulls capabilities from both engines.
- **Rate-limit fallback-key collision** (#47) — When `getConnInfo` failed (no real socket), the bucket key was left at its initial value `"global"` — the same key used by `global: true` mode. Within a single `rateLimit()` instance the buckets Map is closure-scoped so cross-mode pollution couldn't actually happen, but the comment lied and any future refactor that shared a bucket store would silently break. Now assigns `"unknown"` so the per-IP fallback bucket stays distinct from the global bucket.
- **X-Request-ID log injection** (#47) — Header value now passes through a sanitizer that strips ASCII control characters (`\x00`–`\x1f`, `\x7f`), caps at 128 chars, and falls back to a fresh UUID if sanitization empties the value. Defense-in-depth for non-conforming clients/proxies — the Web Headers ctor blocks CRLF at construction, but other control chars pass through.
- **Load test brittleness** (#46) — Per-request `AbortController` so a hung server can't stall a worker forever (uses each scenario's `constraints.timeout_ms` + 5s buffer). Workflow inputs now flow through env vars and numeric validation instead of direct `${{ }}` shell interpolation. JSON artifact preserved on threshold-violation exit. Dolt startup gates on success with an explicit diagnostic. `expectedTier`/`expectedCapabilities` fields are now actually used — the report includes a "ROUTING ASSERTIONS" section listing tier and capability mismatches, and the JSON summary carries `routing_mismatches` for downstream tooling.
- **Migration runner footgun** (#49) — Surfaced (but not fixed) the naïve `split(';')` in `src/db/migrate.ts` that mangles statements when SQL comments contain a semicolon. Worked around it by stripping the offending semicolons from migration 018; a robust quote-and-comment-aware splitter is a follow-up.

## [v0.4.0] — 2026-03-29

Production hardening, routing observability, and a live demo UI.

### Added

- **Cascade trace** (#43) — Every routing attempt across all layers is now captured in a `CascadeTrace` (selected agent, skip reason, latency per layer). New `/observability` endpoint exposes traces. `LayerAttempt` and `CascadeTrace` types are derived from Zod schemas for runtime validation.
- **Live classification demo UI** (#44) — Static frontend (`public/`) with real-time prompt classification visualization. Includes cascade visualization, sample prompts, a setup script (`scripts/demo-setup.ts`), and a `/demo` route.
- **Production guardrails** (#40) — API key authentication enforcement, per-IP rate limiting with `X-RateLimit-Reset` header, and prompt size caps. New middleware: `api-key-auth.ts`, `rate-limit.ts`.
- **Database indexes** (#41) — Migration `017` adds indexes on frequently queried columns (`execution_log.created_at`, etc.) with structural index assertions in tests.

### Fixed

- **Dolt connection safety** (#39) — Branch-mutating operations now require pinned connections, preventing race conditions. Split `withConnection`/`withBranchConnection`. Fixed `routerCommit` `allowEmpty` regression and `DEFAULT_BRANCH` extraction.
- **Agent update silent failure** (#42) — `provider` and `model_id` were missing from `UPDATABLE_COLUMNS`, causing silent no-ops on agent registry updates.
- **IP spoofing in rate limiter** (#40) — Switched to socket remote address. Fixed double-counted rate limits and config leak.
- **Agent capabilities** (#44) — Added `summarization` and `classification` capabilities to T3/T4 agents.
- **Migration runner** (#39) — Fixed semicolon in SQL comment that broke the migration runner.

## [v0.3.0] — 2026-03-19

Closed-loop learning, configurable routing, and broad stability improvements.

### Added

- **Routing tuner** (#36) — Closed-loop learning system that promotes high-signal outcome utterances into crystallized routing rules. Uses `GET_LOCK` for concurrency control, handles multi-signal skew, and deduplicates utterances within batches.
- **Configurable confidence threshold** (#33) — `confidence_threshold` is now loaded from `router_config` instead of being hardcoded (default: `0.5`).
- **T4 agent coverage** (#26) — Added `claude-opus-4-6` as a T4-capable agent to the registry and seed data.
- **Classifier improvements** (#29) — New `multi_step`, `diagnostic`, and `system_design` classifier rules.
- **Tier-based timeouts** (#28) — Task execution now uses tier-appropriate default timeouts.
- **Agent capabilities** (#27) — Added `tool_use` and `vision` capabilities to `claude-sonnet-4-5`.
- **MIT License** (#17).
- **CI workflow** — Dolt integration in GitHub Actions for running integration tests. Claude-powered code review workflow.

### Fixed

- **Orphaned evaluation_pending records** (#31) — Records no longer accumulate when evaluation completes.
- **Cascade router regex patterns** (#30) — Fixed patterns that failed on inflected word forms; restored trailing `\b` on `document`.
- **Observability auth bypass** (#35) — Stats/audit endpoints now correctly require API-key auth.
- **Outcome signal rates** (#21) — Fixed miscounting of pending records as negative values.
- **Deterministic sort order** (#22) — `findByTaskId` and `findByTaskIdAndTier` now return stable ordering.
- **Fallback execution records** (#20) — Synthetic error records are now persisted to DB when fallback execution throws.
- **Detail size limit** (#19) — Added size limit to `DownstreamOutcomeInput` detail field using `Buffer.byteLength`.
- **Connection pool isolation** (#25) — Fixed 6 pre-existing test failures from shared connection pool state.
- **Safe regex log leak** (#24) — Removed regex pattern from ReDoS rejection log messages.
- **Formatting** (#23) — Fixed Prettier-mangled Markdown, added `.md` to ignore list.

## [v0.2.0] — 2026-03-13

Outcome feedback loop, code quality tooling, and security fixes.

### Added

- **Outcome capture** (#4) — 4-tier feedback taxonomy (`success`, `partial`, `failure`, `rejected`) for routing signals. Outcomes feed back into agent scoring.
- **Prettier formatting** (#1) — Codebase-wide formatting with scripts and CI enforcement.
- **Claude GitHub Actions** (#2) — PR assistant and code review workflows.
- **Vulnerability remediation** (#3) — Updated Hono and overrode esbuild for Dependabot alerts.

### Fixed

- **Validation and type safety** (#5) — Input validation fixes, type safety improvements, and ordering bugs.
- **Auth hardening** (#6) — Timing-safe API key comparison, safe `JSON.parse`, scoped auth to protected routes, `safeParse` on outcome input, 404 on missing task.
- **ReDoS protection** — Replaced timing guard with `safe-regex` library.
- **Tier 2 evaluation** — Fixed score inflation, `JSON.parse` crashes, missing `created_at`, null handling, DB round-trip elimination, and singleton race condition. Introduced provider abstraction for evaluation.

## [v0.1.0] — 2026-03-08

Initial release — foundational routing pipeline.

### Added

- **Project scaffolding** — TypeScript 5.5+ with strict mode, ESM via NodeNext, Vitest test harness.
- **Dolt integration** — Schema, 8 migration files, seed data. Tables: `agent_registry`, `task_log`, `execution_log`, `routing_policy`, `session_context`, `capability_taxonomy`, `handoff_summary`.
- **Classifier** — Rules-based engine with 9 pattern-based capability detectors. Scores prompts into complexity tiers T1–T4.
- **Agent selection** — Weighted scoring formula (`capability × 0.5 + cost × 0.3 + latency × 0.2`). Fallback strategies: `NEXT_BEST`, `TIER_UP`, `ABORT`.
- **Execution engine** — Provider invocation with retry and exponential backoff (1s, 2s, 4s). Telemetry recorded to `execution_log`.
- **Providers** — Anthropic, OpenAI, and Local adapters implementing the `AgentProvider` interface.
- **Cascade router** — 3-layer classification replacing regex-only classifier.
- **Memory manager** — Per-task Dolt branches (`session/{taskId}`) for isolated context, merged back on completion.
- **API layer** — Hono HTTP framework with routes: `/health`, `/tasks`, `/agents`, `/observability/*`.
- **CLI** — Commands: `task`, `status`, `agents`, `history`, `stats`, `audit`.

[v0.4.0]: https://github.com/nateking-dev/HAOL/releases/tag/v0.4.0
[v0.3.0]: https://github.com/nateking-dev/HAOL/releases/tag/v0.3.0
[v0.2.0]: https://github.com/nateking-dev/HAOL/releases/tag/v0.2.0
[v0.1.0]: https://github.com/nateking-dev/HAOL/releases/tag/v0.1.0
