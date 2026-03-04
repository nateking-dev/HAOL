# HAOL

**Heterogeneous Agent Orchestration Layer** (pronounced "Hal")

HAOL intelligently routes AI tasks to specialized agent models based on task complexity, required capabilities, and cost constraints. Unlike traditional orchestration systems that treat all models as interchangeable, HAOL treats model heterogeneity as a first-class architectural concern.

## Why HAOL?

Most agent orchestration assumes a homogeneous model pool — every agent is the same provider, model, and cost. This wastes budget routing simple tasks through expensive models and forces specialized tasks into generalist ones.

HAOL solves this by scoring and selecting agents across three dimensions:

- **Capability match** — Does the agent have the skills the task requires?
- **Cost efficiency** — Is the agent within the task's budget ceiling?
- **Latency** — How fast does the agent respond?

All routing decisions are stored in [Dolt](https://www.dolthub.com/), a Git-like version-controlled database, making every configuration change auditable, diffable, and reversible.

## Architecture

```
           ┌───────────┐
           │   Intake  │
           └─────┬─────┘
                 ▼
          ┌──────────────┐
          │  Classifier  │  Rules engine → complexity tier (T1–T4)
          └──────┬───────┘  + required capabilities + cost ceiling
                 ▼
        ┌────────────────┐
        │ Agent Selection│  Weighted scoring across candidates
        └────────┬───────┘  capability × 0.5 + cost × 0.3 + latency × 0.2
                 ▼
          ┌──────────────┐
          │  Execution   │  Provider-specific invocation + retry logic
          └──────┬───────┘
                 ▼
           ┌───────────┐
           │  Commit   │  Atomic Dolt commit with full telemetry
           └───────────┘
```

### Complexity Tiers

| Tier | Description | Example Tasks | Default Cost Ceiling |
|------|-------------|---------------|---------------------|
| T1 | Trivial | Reformatting, simple lookups | $0.001 |
| T2 | Standard | Summarization, Q&A, translation | $0.01 |
| T3 | Complex | Multi-step reasoning, code generation | $0.10 |
| T4 | Expert | Research synthesis, architecture design | $1.00 |

### Core Subsystems

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| **Classifier** | `src/classifier/` | Rules-based task analysis — determines tier, capabilities, and cost ceiling |
| **Agent Selection** | `src/services/agent-selection.ts` | Filters candidates, scores them, picks the best match |
| **Execution Engine** | `src/services/execution.ts` | Invokes agents via provider adapters with retry and fallback |
| **Router** | `src/router/router.ts` | Orchestrates the full pipeline from intake to commit |
| **Memory Manager** | `src/memory/` | Session branches in Dolt for per-task context persistence |

### Provider Adapters

HAOL supports multiple LLM providers through a common interface:

| Provider | Module | Models |
|----------|--------|--------|
| Anthropic | `src/providers/anthropic.ts` | Claude Haiku, Sonnet, Opus |
| OpenAI | `src/providers/openai.ts` | GPT-4o, GPT-4o-mini |
| Local | `src/providers/local.ts` | Ollama, vLLM, or any local model |

Each provider implements:
- `invoke(request)` — Call the model
- `healthCheck()` — Verify availability
- `estimateTokens(prompt)` — Token estimation

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.5 (strict mode, ESM)
- **HTTP Framework:** [Hono](https://hono.dev/) 4.x
- **Database:** [Dolt](https://www.dolthub.com/) (MySQL-compatible, Git-like VCS)
- **Driver:** mysql2
- **Validation:** Zod 4.x
- **Testing:** Vitest 2.x
- **Dev Runner:** tsx

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **Dolt** — [Install Dolt](https://docs.dolthub.com/introduction/installation)

### Installation

```bash
git clone <repo-url>
cd HAOL
npm install
```

### Database Setup

Initialize a Dolt database and start the SQL server:

```bash
mkdir -p haol && cd haol
dolt init
dolt sql-server &
cd ..
```

Copy the environment template and configure:

```bash
cp .env.example .env
# Edit .env with your Dolt connection and API keys
```

Run migrations and seed data:

```bash
npm run migrate    # Apply schema (7 tables + seed taxonomy)
npm run seed       # Insert default routing policy + sample agents
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLT_HOST` | `127.0.0.1` | Dolt SQL server host |
| `DOLT_PORT` | `3306` | Dolt SQL server port |
| `DOLT_USER` | `root` | Database user |
| `DOLT_PASSWORD` | _(empty)_ | Database password |
| `DOLT_DATABASE` | `haol` | Database name |
| `DOLT_POOL_SIZE` | `5` | Connection pool size |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (for Claude models) |
| `OPENAI_API_KEY` | — | OpenAI API key (for GPT models) |
| `PORT` | `3000` | HTTP server port |

### Running

```bash
# Development (with hot reload via tsx)
npm run dev

# Production
npm run build
node dist/index.js
```

### Testing

```bash
npm run test          # Run all tests once
npm run test:watch    # Watch mode
```

## API

### Task Submission

```bash
# Submit a task
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize the key points of this article..."}'

# Check task status
curl http://localhost:3000/tasks/<task_id>
```

### Agent Management

```bash
# List agents
curl http://localhost:3000/agents

# Filter by capability
curl http://localhost:3000/agents?capability=code_generation

# Register an agent
curl -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "claude-sonnet",
    "provider": "anthropic",
    "model_id": "claude-sonnet-4-20250514",
    "capabilities": ["code_generation", "reasoning"],
    "tier_ceiling": 3,
    "cost_per_1k_input": 0.003,
    "cost_per_1k_output": 0.015
  }'
```

### Observability

```bash
curl http://localhost:3000/observability/costs
curl http://localhost:3000/observability/stats
curl http://localhost:3000/observability/history
```

### Health Check

```bash
curl http://localhost:3000/
```

## CLI

```bash
# Submit a task
haol task "Explain how TCP handshakes work"

# Submit with constraints
haol task "Generate a REST API" --tier 3 --cap code_generation

# Check task status
haol status <task_id>

# List agents
haol agents list

# Update/disable an agent
haol agents update <agent_id>
haol agents remove <agent_id>

# View task history
haol history --last 20

# Dashboard statistics
haol stats --hours 24

# Audit trail
haol audit commits --last 10
haol audit agents
```

Output formats: `--format table` (default), `--format json`, `--format minimal`

## Database Schema

HAOL uses 7 tables in Dolt:

| Table | Purpose |
|-------|---------|
| `agent_registry` | Agent definitions — provider, model, capabilities, cost, status, tier ceiling |
| `capability_taxonomy` | Controlled vocabulary of capabilities with tier minimums |
| `task_log` | Immutable task lifecycle (RECEIVED → CLASSIFIED → DISPATCHED → COMPLETED/FAILED) |
| `execution_log` | Per-invocation telemetry — tokens, cost, latency, outcome |
| `routing_policy` | Configurable scoring weights and fallback strategy |
| `session_context` | Per-session key-value memory store |
| `handoff_summary` | Cross-agent context transfer |

Because the backing store is Dolt, every change is a commit. You can:

- `dolt diff` any two points in time
- `dolt log` the full history of routing decisions
- `dolt branch` to test policy changes before merging
- `dolt blame` to trace who changed what and when

## Project Structure

```
src/
├── api/                 # Hono HTTP API (routes + middleware)
├── bin/                 # CLI entry point
├── classifier/          # Task classification (rules + scoring)
├── cli/                 # CLI commands and output formatting
├── db/                  # Dolt connection, migrations, seeds
│   └── migrations/      # SQL migration files (001–008)
├── memory/              # Session branch management + cleanup
├── observability/       # Dashboard metrics + analytics queries
├── providers/           # LLM provider adapters (Anthropic, OpenAI, local)
├── repositories/        # Data access layer for each table
├── router/              # Main orchestration pipeline
├── services/            # Business logic (selection, execution)
├── types/               # TypeScript interfaces + Zod schemas
└── index.ts             # Server entry point
tests/                   # Mirrors src/ structure (70+ tests)
```

## How Routing Works

1. **Intake** — Task is received and logged with status `RECEIVED`
2. **Classification** — Rules engine analyzes the prompt, assigns a complexity tier (T1–T4), extracts required capabilities, and sets a cost ceiling
3. **Agent Selection** — Candidates are filtered by tier ceiling, capabilities, and cost. Survivors are scored: `capability × 0.5 + cost × 0.3 + latency × 0.2`. The top scorer is selected
4. **Execution** — The selected agent is invoked via its provider adapter. On failure, exponential backoff retries are attempted
5. **Fallback** — If execution still fails, the fallback strategy kicks in (`NEXT_BEST` picks the runner-up, `TIER_UP` relaxes constraints, `ABORT` gives up)
6. **Commit** — An atomic Dolt commit records the full lifecycle: `task:<id> | tier:T3 | agent:claude-sonnet | cost:$0.0045 | 1234ms`

## Seed Data

The seed script (`npm run seed`) provisions:

| Agent | Provider | Tier Ceiling | Use Case |
|-------|----------|-------------|----------|
| `claude-haiku` | Anthropic | T2 | Fast, cheap tasks |
| `claude-sonnet` | Anthropic | T3 | Complex reasoning |
| `gpt-4o-mini` | OpenAI | T2 | Standard tasks |
| `local-llama` | Local | T1 | Trivial/free tasks |

Default routing policy: 50% capability weight, 30% cost weight, 20% latency weight, `NEXT_BEST` fallback, 2 max retries.
