# Changelog

All notable changes to the HAOL (Heterogeneous Agent Orchestration Layer) project are documented in this file.

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
