# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HAOL (Heterogeneous Agent Orchestration Layer) routes AI tasks to specialized agent models based on complexity, capabilities, and cost. It uses Dolt (a Git-like version-controlled MySQL database) to make every routing decision auditable and reversible.

## Commands

```bash
npm run build          # TypeScript compilation to dist/
npm run dev            # Development server with hot reload (tsx)
npm run test           # Run all tests once (vitest)
npm run test:watch     # Watch mode
npm run migrate        # Apply Dolt schema migrations
npm run seed           # Insert default agents + routing policy
npx vitest run tests/path/to/file.test.ts   # Run a single test file
```

## Architecture

The system follows a pipeline pattern orchestrated by `src/router/router.ts`:

**Intake → Classification → Agent Selection → Execution → Fallback → Dolt Commit**

### Key Layers

- **Classifier** (`src/classifier/`): Rules engine that analyzes prompts to determine complexity tier (T1-T4), required capabilities, and cost ceiling. `rules.ts` has 9 pattern-based capability detectors; `scoring.ts` computes the tier.
- **Agent Selection** (`src/services/agent-selection.ts`): Filters agents by tier/capabilities/cost, then scores with weighted formula: `capability × 0.5 + cost × 0.3 + latency × 0.2`. Fallback strategies: NEXT_BEST, TIER_UP, ABORT.
- **Execution Engine** (`src/services/execution.ts`): Invokes providers with retry + exponential backoff (1s, 2s, 4s). Records telemetry to `execution_log`.
- **Providers** (`src/providers/`): Anthropic, OpenAI, and Local adapters all implement the `AgentProvider` interface (`invoke`, `healthCheck`, `estimateTokens`).
- **Repositories** (`src/repositories/`): Data access layer — one file per table.
- **Memory** (`src/memory/`): Creates per-task Dolt branches (`session/{taskId}`) for isolated context, merges back on completion.

### API

Hono HTTP framework. Routes in `src/api/routes/`. Endpoints: `/health`, `/tasks`, `/agents`, `/observability/*`.

### CLI

Entry point: `src/bin/haol.ts` → `src/cli/index.ts`. Commands: `task`, `status`, `agents`, `history`, `stats`, `audit`.

## Tech Stack

- TypeScript 5.5+ (strict mode, ESM via NodeNext)
- Hono 4.x (HTTP framework)
- Dolt/mysql2 (version-controlled database)
- Zod 4.x (runtime validation — all inputs validated with Zod schemas)
- Vitest 2.x (testing)
- Node.js >= 20

## Database

Dolt (MySQL-compatible). 8 migration files in `src/db/migrations/`. Key tables: `agent_registry`, `task_log`, `execution_log`, `routing_policy`, `session_context`, `capability_taxonomy`, `handoff_summary`.

Every mutation results in a Dolt commit with telemetry in the commit message.

## Testing

Tests mirror `src/` structure in `tests/`. Tests skip gracefully when Dolt is unavailable. Serial file execution is configured (`fileParallelism: false`). Tests clean up their own data using LIKE queries in afterAll hooks.

## Environment

Requires `.env` with `DOLT_HOST`, `DOLT_PORT`, `DOLT_USER`, `DOLT_PASSWORD`, `DOLT_DATABASE`, plus `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for provider adapters. See `.env.example`.
