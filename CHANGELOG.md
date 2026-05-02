# Changelog

All notable changes to the HAOL (Heterogeneous Agent Orchestration Layer) project are documented in this file.

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
