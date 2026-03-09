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
        ┌──────────────────┐
        │  Cascade Router  │  3-layer classification (see below)
        └────────┬─────────┘
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

Every task is classified into one of four complexity tiers. The tier determines which agents are eligible and how much the task is allowed to cost.

| Tier | Name     | Example Tasks                                            | Cost Ceiling |
| ---- | -------- | -------------------------------------------------------- | ------------ |
| T1   | Simple   | Summarization, simple lookups, basic Q&A                 | $0.01        |
| T2   | Moderate | Structured output, translation, sentiment analysis       | $0.05        |
| T3   | Complex  | Code generation, multi-step reasoning, debugging         | $0.50        |
| T4   | Expert   | Multi-capability tasks, vision + code, full-stack design | $5.00        |

---

## Cascade Router: How Classification Works

The cascade router is the system that decides _which tier a task belongs to_. It uses a three-layer architecture that balances speed against accuracy — simple tasks are classified in microseconds by pattern matching, while ambiguous tasks escalate through progressively smarter (and slower) layers.

```
  Incoming prompt
        │
        ▼
  ┌─────────────────────────────────┐
  │  Layer 0: Deterministic Rules   │  ~0.1 ms
  │  Regex, prefix, and contains    │
  │  pattern matching               │
  └──────────────┬──────────────────┘
                 │
          match? ├── YES → done (confidence: 1.0)
                 │
                 NO
                 ▼
  ┌─────────────────────────────────┐
  │  Layer 1: Semantic Similarity   │  ~200 ms (embedding API call)
  │  Embed the prompt, compare to   │
  │  32 reference utterances        │
  └──────────────┬──────────────────┘
                 │
     confident?  ├── YES (≥ 0.72) → done
                 │
                 NO
                 ▼
  ┌─────────────────────────────────┐
  │  Layer 2: LLM Escalation        │  ~800 ms (LLM API call)
  │  Ask a cheap, fast LLM to       │
  │  classify the task              │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │  Fallback: Default to T3        │  Conservative — may overspend
  └─────────────────────────────────┘
```

### Layer 0: Deterministic Rules

The fastest layer. A set of rules stored in the `routing_rules` database table are evaluated against the prompt in priority order. Each rule has a type, a pattern, and a target tier:

| Rule Type  | How It Matches                             | Example                                        |
| ---------- | ------------------------------------------ | ---------------------------------------------- |
| `regex`    | Regular expression test (case-insensitive) | `\bsummariz` matches "Summarize this..."       |
| `prefix`   | Prompt starts with the pattern             | `translate` matches "Translate this to French" |
| `contains` | Prompt includes the pattern anywhere       | `json` matches "...output as JSON please"      |
| `metadata` | Matches on structured metadata fields      | Used for programmatic tier overrides           |

If multiple rules match, the router takes the **highest tier** among them and merges all their capabilities. For example, if a prompt matches both a T1 summarization rule and a T3 code rule, the task is classified as T3 with capabilities `["summarization", "code_generation"]`.

Rules are stored in Dolt, so you can add, edit, or disable them without code changes — and every change is version-controlled.

**When Layer 0 resolves:** The prompt contains clear keywords that match a rule. This handles the majority of well-structured requests in under a millisecond.

**When it doesn't:** The prompt is ambiguous, uses unusual phrasing, or describes a task without trigger words. For example, "Help me with my project" doesn't match any regex rule.

### Layer 1: Semantic Similarity

When no rules match, the router needs to _understand_ what the prompt means rather than just scan for keywords. This is where embeddings come in.

#### What are embeddings?

An embedding is a way to represent text as a list of numbers (a "vector") that captures its meaning. Two pieces of text that mean similar things will have similar vectors, even if they use completely different words.

For example, these two prompts mean similar things:

- "What is the tallest mountain in the world?"
- "Which peak has the highest elevation globally?"

A keyword search would see zero overlap. But their embedding vectors will be very close together in the vector space, because they express the same intent.

HAOL uses OpenAI's `text-embedding-3-small` model to compute 512-dimensional embeddings. Each number in the vector represents some learned aspect of the text's meaning — things like topic, complexity, formality, domain, and many abstract features that don't have clean human labels.

#### How similarity routing works

During setup, 32 **reference utterances** (8 per tier) are embedded and stored in the `routing_utterances` table. These are representative examples of what each tier's workload looks like:

- **T1 examples:** "What is the capital of France?", "Summarize this paragraph in one sentence"
- **T2 examples:** "Convert this CSV data into a formatted JSON schema", "Analyze the sentiment of these customer reviews"
- **T3 examples:** "Write a Python function that implements binary search with error handling", "Debug this React component that has a memory leak"
- **T4 examples:** "Build a full-stack application with authentication, API, and database layer", "Analyze this screenshot of a UI and generate the corresponding React code"

When a new prompt arrives:

1. **Embed the prompt** — Send it to OpenAI's embedding API to get its 512-dimensional vector (~200ms)
2. **Compare against all reference utterances** — Compute the [cosine similarity](https://en.wikipedia.org/wiki/Cosine_similarity) between the prompt's vector and each reference utterance's vector. Cosine similarity ranges from -1 (opposite meaning) to 1 (identical meaning)
3. **Pick the top K matches** (default: 5) — Sort by similarity score, take the best 5
4. **Weighted vote** — Each of the top 5 matches "votes" for its tier, weighted by its similarity score. If 4 of 5 top matches are T1 utterances, the vote strongly favors T1
5. **Confidence check** — If the winning tier's vote share is ≥ 0.72 (the `similarity_threshold`), accept the result. Otherwise, escalate to Layer 2

**Example:** The prompt "What is the tallest mountain in the world?" has no rule-matching keywords, but its embedding is very close to the T1 reference utterance "What is the capital of France?" — both are simple factual questions. The top 5 matches are all T1 utterances, giving a confidence of 0.84, which exceeds the threshold. Result: T1, resolved in ~1.2 seconds (dominated by the embedding API call).

#### Why cosine similarity?

Cosine similarity measures the angle between two vectors, ignoring their magnitude. This matters because embeddings can vary in length depending on the input text, but the _direction_ of the vector is what encodes meaning. Two vectors pointing in the same direction have a cosine similarity of 1, regardless of how long they are.

The math is straightforward:

```
cosine_similarity(a, b) = (a · b) / (|a| × |b|)
```

Where `a · b` is the dot product (multiply corresponding elements, sum the results) and `|a|` is the vector's magnitude (square root of the sum of squared elements).

### Layer 2: LLM Escalation

When semantic similarity is inconclusive (confidence below 0.72), the router asks a cheap, fast LLM to classify the task. HAOL uses `claude-haiku-4-5` for this — it's inexpensive (~$0.001 per classification) and responds in under a second.

The LLM receives a system prompt describing the four tiers and is asked to return a JSON response:

```json
{ "tier": 3, "capabilities": ["reasoning"], "confidence": 0.85 }
```

The response is validated with Zod. If parsing fails (malformed JSON, invalid tier, etc.), the router falls back to T3 — a conservative default that may overspend but won't under-provision.

**When Layer 2 helps:** The prompt is genuinely ambiguous. "Help me with my project" could be T1 (simple question) or T4 (build an entire system). The LLM can use its understanding of context and intent to make a judgment call that pattern matching and similarity can't.

### Fallback

If all layers fail — no rules match, no embeddings are available, escalation is disabled or errors out — the router defaults to **T3**. This is deliberately conservative: a T3 classification may route to a more expensive agent than necessary, but it won't fail the task by under-provisioning.

### Capability Detection

Capabilities are detected **independently from tier classification**. Regardless of which cascade layer determines the tier, the router always runs regex-based capability matching against the prompt. This uses the same 9 pattern rules from the original classifier:

| Capability          | Trigger Patterns                           |
| ------------------- | ------------------------------------------ |
| `summarization`     | summarize, extract, condense               |
| `classification`    | classify, categorize, label                |
| `code_generation`   | code, implement, function, debug, refactor |
| `reasoning`         | analyze, compare, reason, evaluate         |
| `vision`            | image, screenshot, diagram, photo          |
| `structured_output` | json, schema, structured, table            |
| `long_context`      | entire...document, full...text             |
| `tool_use`          | tool, api...call, function.call            |
| `multilingual`      | translate, multilingual                    |

Capabilities from Layer 0 rules, Layer 2 LLM responses, and metadata overrides are all merged together. The agent selection algorithm then uses this combined capability set to filter eligible agents.

### Graceful Degradation

The cascade router is designed to fail gracefully at every level:

- **Cascade tables don't exist or aren't seeded** → The router falls back to the original regex-only classifier (`src/classifier/`), which is preserved intact
- **No OpenAI API key** → Layer 1 (semantic similarity) is skipped; the router goes directly from Layer 0 to Layer 2
- **No Anthropic API key** → Layer 2 (LLM escalation) is skipped; the router falls back to the default tier
- **Embedding API fails** → Caught and logged; falls back to Layer 2 or default tier
- **LLM returns invalid JSON** → Caught by Zod validation; returns T3 with 0.5 confidence
- **Routing log write fails** → Caught silently; classification still succeeds

### Configuration

All cascade router thresholds are stored in the `router_config` table and can be tuned without code changes:

| Key                    | Default                     | What It Controls                                                |
| ---------------------- | --------------------------- | --------------------------------------------------------------- |
| `similarity_threshold` | `0.72`                      | Minimum cosine similarity confidence to accept Layer 1's result |
| `escalation_threshold` | `0.55`                      | Below this confidence, Layer 1 escalates to Layer 2             |
| `top_k`                | `5`                         | Number of nearest reference utterances to consider              |
| `default_tier`         | `3`                         | Fallback tier when all layers are inconclusive                  |
| `enable_escalation`    | `true`                      | Whether Layer 2 (LLM) is active                                 |
| `embedding_model`      | `text-embedding-3-small`    | OpenAI model used for runtime embeddings                        |
| `embedding_dimensions` | `512`                       | Vector dimensionality (lower = faster, less precise)            |
| `escalation_model`     | `claude-haiku-4-5-20251001` | LLM used for Layer 2 classification                             |

### Routing Log

Every routing decision is recorded in the `routing_log` table:

```sql
SELECT routed_tier, routing_layer, confidence, latency_ms, LEFT(input_text, 50)
FROM routing_log
ORDER BY created_at DESC
LIMIT 5;
```

```
+---------+---------------+----------+-----------+----------------------------------------------------+
| tier    | layer         | confid.  | latency   | input_text                                         |
+---------+---------------+----------+-----------+----------------------------------------------------+
| 1       | deterministic | 1.000    | 0.52 ms   | Summarize this paragraph about climate change      |
| 2       | deterministic | 1.000    | 0.02 ms   | Convert this to a JSON schema                      |
| 1       | semantic      | 0.837    | 1205.9 ms | What is the tallest mountain in the world?          |
| 3       | escalation    | 0.500    | 779.1 ms  | Help me with my project                            |
| 3       | deterministic | 1.000    | 0.14 ms   | Write a function that sorts an array               |
+---------+---------------+----------+-----------+----------------------------------------------------+
```

This audit trail lets you see exactly which layer handled each request, how confident it was, and how long it took — useful for tuning thresholds and identifying gaps in your rule set or reference utterances.

---

## Agent Selection

Once the cascade router assigns a tier and capabilities, the agent selection algorithm picks the best agent for the job.

### Filtering

Candidates are eliminated if they don't meet the minimum requirements:

1. **Status** — Agent must be `active`
2. **Tier ceiling** — Agent's `tier_ceiling` must be ≥ the task's tier
3. **Capabilities** — Agent must have every capability the task requires
4. **Cost** — Agent's estimated cost must be ≤ the task's cost ceiling

### Scoring

Surviving candidates are scored with a weighted formula:

```
score = capability × 0.5 + cost × 0.3 + latency × 0.2
```

- **Capability score** — Fraction of the agent's capabilities that match the task's requirements (agents with extra capabilities score higher)
- **Cost score** — Inverse of cost relative to the ceiling (cheaper agents score higher)
- **Latency score** — Inverse of latency relative to the slowest candidate (faster agents score higher)

The weights are configurable via the `routing_policy` table.

### Fallback Strategies

If execution fails with the selected agent, the fallback strategy kicks in:

| Strategy    | Behavior                                 |
| ----------- | ---------------------------------------- |
| `NEXT_BEST` | Try the second-highest-scoring candidate |
| `TIER_UP`   | Relax tier constraints and re-select     |
| `ABORT`     | Mark the task as failed                  |

## Core Subsystems

| Subsystem             | Location                          | Purpose                                                      |
| --------------------- | --------------------------------- | ------------------------------------------------------------ |
| **Cascade Router**    | `src/cascade-router/`             | 3-layer task classification (rules → similarity → LLM)       |
| **Legacy Classifier** | `src/classifier/`                 | Original regex-only classifier (kept as fallback)            |
| **Agent Selection**   | `src/services/agent-selection.ts` | Filters candidates, scores them, picks the best match        |
| **Execution Engine**  | `src/services/execution.ts`       | Invokes agents via provider adapters with retry and fallback |
| **Router**            | `src/router/router.ts`            | Orchestrates the full pipeline from intake to commit         |
| **Memory Manager**    | `src/memory/`                     | Session branches in Dolt for per-task context persistence    |

### Provider Adapters

HAOL supports multiple LLM providers through a common interface:

| Provider  | Module                       | Models                           |
| --------- | ---------------------------- | -------------------------------- |
| Anthropic | `src/providers/anthropic.ts` | Claude Haiku, Sonnet, Opus       |
| OpenAI    | `src/providers/openai.ts`    | GPT-4o, GPT-4o-mini              |
| Local     | `src/providers/local.ts`     | Ollama, vLLM, or any local model |

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

Run migrations, seed data, and compute embeddings:

```bash
npm run migrate          # Apply schema (9 migrations, 12 tables)
npm run seed             # Insert agents, routing policy, tiers, rules, config, and reference utterances
npm run seed:embeddings  # Compute embeddings for the 32 reference utterances via OpenAI (requires OPENAI_API_KEY)
```

The `seed:embeddings` step calls the OpenAI embeddings API once to compute vectors for all 32 reference utterances in a single batch request. This is a one-time operation — the embeddings are stored in Dolt and version-controlled like everything else.

### Environment Variables

| Variable            | Default     | Description                                                  |
| ------------------- | ----------- | ------------------------------------------------------------ |
| `DOLT_HOST`         | `127.0.0.1` | Dolt SQL server host                                         |
| `DOLT_PORT`         | `3306`      | Dolt SQL server port                                         |
| `DOLT_USER`         | `root`      | Database user                                                |
| `DOLT_PASSWORD`     | _(empty)_   | Database password                                            |
| `DOLT_DATABASE`     | `haol`      | Database name                                                |
| `DOLT_POOL_SIZE`    | `5`         | Connection pool size                                         |
| `ANTHROPIC_API_KEY` | —           | Anthropic API key (for Claude models and Layer 2 escalation) |
| `OPENAI_API_KEY`    | —           | OpenAI API key (for GPT models and embedding computation)    |
| `PORT`              | `3000`      | HTTP server port                                             |

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

Tests skip gracefully when Dolt is unavailable. The cascade router has full unit test coverage with mocked providers — no API keys or database needed.

## API

### Task Submission

```bash
# Submit a task
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize the key points of this article..."}'

# Submit with tier override
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "metadata": {"tier": 4}}'

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
curl http://localhost:3000/health
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

HAOL uses 12 tables in Dolt:

| Table                 | Purpose                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `agent_registry`      | Agent definitions — provider, model, capabilities, cost, status, tier ceiling    |
| `capability_taxonomy` | Controlled vocabulary of capabilities with tier minimums                         |
| `task_log`            | Immutable task lifecycle (RECEIVED → CLASSIFIED → DISPATCHED → COMPLETED/FAILED) |
| `execution_log`       | Per-invocation telemetry — tokens, cost, latency, outcome                        |
| `routing_policy`      | Configurable scoring weights and fallback strategy                               |
| `session_context`     | Per-session key-value memory store                                               |
| `handoff_summary`     | Cross-agent context transfer                                                     |
| `routing_tiers`       | Tier definitions — name, description, default agent                              |
| `routing_rules`       | Deterministic rules for Layer 0 — pattern, type, tier, capabilities              |
| `routing_utterances`  | Reference utterances with pre-computed embeddings for Layer 1                    |
| `router_config`       | Key-value configuration for cascade router thresholds                            |
| `routing_log`         | Audit trail of every routing decision — layer, confidence, latency               |

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
├── cascade-router/      # 3-layer cascade classification
│   ├── types.ts         #   Type definitions
│   ├── cascade-router.ts#   Core orchestrator (Layer 0 → 1 → 2 → fallback)
│   ├── classify.ts      #   Singleton wrapper with graceful degradation
│   ├── similarity.ts    #   Cosine similarity + weighted tier voting
│   ├── reference-store.ts#  Data access (rules, utterances, config, log)
│   ├── embedding-openai.ts# OpenAI embedding provider
│   ├── embedding.ts     #   Embedding provider factory
│   ├── escalation.ts    #   Anthropic LLM escalation provider
│   ├── seed-embeddings.ts#  Script to compute utterance embeddings
│   └── index.ts         #   Barrel exports
├── classifier/          # Legacy regex-only classifier (fallback)
├── cli/                 # CLI commands and output formatting
├── db/                  # Dolt connection, migrations, seeds
│   └── migrations/      # SQL migration files (001–009)
├── memory/              # Session branch management + cleanup
├── observability/       # Dashboard metrics + analytics queries
├── providers/           # LLM provider adapters (Anthropic, OpenAI, local)
├── repositories/        # Data access layer for each table
├── router/              # Main orchestration pipeline
├── services/            # Business logic (selection, execution)
├── types/               # TypeScript interfaces + Zod schemas
└── index.ts             # Server entry point
tests/                   # Mirrors src/ structure (215+ tests)
```

## How Routing Works (End to End)

1. **Intake** — Task is received via API or CLI and logged with status `RECEIVED`
2. **Classification** — The cascade router classifies the task:
   - Tries Layer 0 (regex rules) — resolves in < 1ms if a rule matches
   - Tries Layer 1 (semantic similarity) — embeds the prompt and compares against reference utterances
   - Tries Layer 2 (LLM escalation) — asks Claude Haiku to classify ambiguous prompts
   - Falls back to T3 if all layers are inconclusive
   - If the cascade router isn't available (tables not seeded, no API keys), the legacy regex classifier handles it
3. **Agent Selection** — Candidates are filtered by tier ceiling, capabilities, and cost. Survivors are scored: `capability × 0.5 + cost × 0.3 + latency × 0.2`. The top scorer is selected
4. **Execution** — The selected agent is invoked via its provider adapter. On failure, exponential backoff retries are attempted (1s, 2s, 4s)
5. **Fallback** — If execution still fails, the fallback strategy kicks in (`NEXT_BEST` picks the runner-up, `TIER_UP` relaxes constraints, `ABORT` gives up)
6. **Commit** — An atomic Dolt commit records the full lifecycle: `task:<id> | tier:T3 | agent:claude-sonnet | cost:$0.0045 | 1234ms`

## Seed Data

The seed script (`npm run seed`) provisions:

| Agent               | Provider  | Tier Ceiling | Use Case           |
| ------------------- | --------- | ------------ | ------------------ |
| `claude-haiku-4-5`  | Anthropic | T2           | Fast, cheap tasks  |
| `claude-sonnet-4-5` | Anthropic | T3           | Complex reasoning  |
| `gpt-4o-mini`       | OpenAI    | T2           | Standard tasks     |
| `local-llama`       | Local     | T1           | Trivial/free tasks |

Default routing policy: 50% capability weight, 30% cost weight, 20% latency weight, `NEXT_BEST` fallback, 2 max retries.

### Adding Reference Utterances

To improve Layer 1 accuracy, add more reference utterances to the `routing_utterances` table and re-run `npm run seed:embeddings`:

```sql
INSERT INTO routing_utterances (utterance_id, tier_id, utterance_text, embedding, embedding_model, embedding_dim, source)
VALUES ('utt-custom-01', 2, 'Reformat this data as a markdown table', '[]', 'pending', 0, 'manual');
```

Then:

```bash
npm run seed:embeddings  # Computes embeddings for any rows with embedding_model='pending'
```

The more representative utterances each tier has, the more accurately Layer 1 will classify prompts that don't match any deterministic rule.
