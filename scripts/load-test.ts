/**
 * HAOL Load Test — Realistic Scenario Generator
 *
 * Submits a diverse mix of prompts across all tiers and capabilities,
 * then produces a summary report. Doubles as a CI regression gate when
 * threshold flags are supplied.
 *
 * Usage:
 *   npx tsx scripts/load-test.ts [options]
 *
 * Options:
 *   --base-url <url>           Target HAOL server (default: http://localhost:3000)
 *   --concurrency <n>          Parallel workers (default: 3)
 *   --api-key <key>            Bearer token, also read from HAOL_API_KEY env
 *   --json                     Emit a JSON summary line after the report
 *   --max-p95-latency-ms <n>   Fail if overall p95 wall latency exceeds n
 *   --max-cost-usd <n>         Fail if total cost exceeds n
 *   --max-failure-rate <pct>   Fail if (failed+errored)/total exceeds pct (e.g. 0.1 = 10%)
 *
 * Exit codes:
 *   0  all scenarios completed and any thresholds were satisfied
 *   1  health check failed, network error, or a threshold was violated
 */

const BASE_URL = getArg("--base-url") ?? "http://localhost:3000";
const CONCURRENCY = parseInt(getArg("--concurrency") ?? "3", 10);
const API_KEY = getArg("--api-key") ?? process.env.HAOL_API_KEY ?? "";
const EMIT_JSON = hasFlag("--json");
const MAX_P95_LATENCY_MS = numArg("--max-p95-latency-ms");
const MAX_COST_USD = numArg("--max-cost-usd");
const MAX_FAILURE_RATE = numArg("--max-failure-rate");

// ── Scenario definitions ────────────────────────────────────────────

interface Scenario {
  name: string;
  expectedTier: number;
  expectedCapabilities: string[];
  request: {
    prompt: string;
    metadata?: { tier?: number; capabilities?: string[] };
    constraints?: { max_tokens?: number; timeout_ms?: number; temperature?: number };
    expected_format?: { type?: string };
  };
}

const scenarios: Scenario[] = [
  // ── T1: Simple classification / summarization ──
  {
    name: "Email spam classification",
    expectedTier: 1,
    expectedCapabilities: ["classification"],
    request: {
      prompt:
        "Classify this email as spam or not spam: 'Congratulations! You've won a free iPhone. Click here to claim your prize now!'",
    },
  },
  {
    name: "Sentiment labeling",
    expectedTier: 1,
    expectedCapabilities: ["classification"],
    request: {
      prompt:
        "Categorize the sentiment of this product review as positive, negative, or neutral: 'The battery life is decent but the screen quality is disappointing for the price.'",
    },
  },
  {
    name: "Short text summarization",
    expectedTier: 1,
    expectedCapabilities: ["summarization"],
    request: {
      prompt:
        "Summarize the following in one sentence: 'The Federal Reserve announced today that it will keep interest rates unchanged at 5.25-5.50%, citing persistent inflation concerns despite recent cooling in the labor market. Chair Powell emphasized the need for continued vigilance.'",
    },
  },
  {
    name: "Topic labeling",
    expectedTier: 1,
    expectedCapabilities: ["classification"],
    request: {
      prompt:
        "Label these support tickets with categories (billing, technical, feature-request, account): 'I can't log in after resetting my password yesterday.'",
    },
  },
  {
    name: "Simple extraction",
    expectedTier: 1,
    expectedCapabilities: ["summarization"],
    request: {
      prompt:
        "Extract the key dates and amounts from this text: 'The contract was signed on March 1, 2026, for a total of $450,000, with the first payment of $150,000 due on April 15, 2026.'",
    },
  },

  // ── T2: Reasoning, code, structured output ──
  {
    name: "Code generation — Python utility",
    expectedTier: 2,
    expectedCapabilities: ["code_generation"],
    request: {
      prompt:
        "Write a Python function that implements a least-recently-used (LRU) cache with O(1) get and put operations. Include type hints and docstrings.",
    },
  },
  {
    name: "Comparative analysis",
    expectedTier: 2,
    expectedCapabilities: ["reasoning"],
    request: {
      prompt:
        "Compare and evaluate the trade-offs between using PostgreSQL vs DynamoDB for a multi-tenant SaaS application that handles 10,000 requests/second with complex querying needs.",
    },
  },
  {
    name: "JSON structured output",
    expectedTier: 2,
    expectedCapabilities: ["structured_output", "reasoning"],
    request: {
      prompt:
        'Analyze this error log and return a structured JSON object with fields: error_type, root_cause, severity (1-5), and recommended_fix.\n\nError: "FATAL: connection pool exhausted — 50/50 connections in use, 23 idle transactions detected, oldest idle txn: 47 minutes"',
      expected_format: { type: "json" },
    },
  },
  {
    name: "Debug existing code",
    expectedTier: 2,
    expectedCapabilities: ["code_generation"],
    request: {
      prompt:
        "Debug this JavaScript function that should flatten a nested array but returns incorrect results:\n\nfunction flatten(arr) {\n  return arr.reduce((acc, val) => {\n    if (Array.isArray(val)) {\n      acc.concat(flatten(val));\n    } else {\n      acc.push(val);\n    }\n    return acc;\n  }, []);\n}\n\nExplain the bug and provide the corrected version.",
    },
  },
  {
    name: "Refactor suggestion",
    expectedTier: 2,
    expectedCapabilities: ["code_generation", "reasoning"],
    request: {
      prompt:
        "Refactor this Express middleware to use async/await and proper error handling:\n\napp.use(function(req, res, next) {\n  db.getUser(req.headers.token, function(err, user) {\n    if (err) { res.status(500).send('error'); return; }\n    if (!user) { res.status(401).send('unauthorized'); return; }\n    req.user = user;\n    db.getPermissions(user.id, function(err, perms) {\n      if (err) { res.status(500).send('error'); return; }\n      req.permissions = perms;\n      next();\n    });\n  });\n});",
    },
  },
  {
    name: "Multi-language translation",
    expectedTier: 1,
    expectedCapabilities: ["multilingual"],
    request: {
      prompt:
        "Translate this error message into Spanish, French, and German: 'Your session has expired. Please log in again to continue.'",
    },
  },
  {
    name: "Data table generation",
    expectedTier: 1,
    expectedCapabilities: ["structured_output"],
    request: {
      prompt:
        "Create a structured table comparing these cloud providers on compute, storage, and database pricing: AWS, GCP, Azure. Include the service name and starting price for each.",
      expected_format: { type: "table" },
    },
  },

  // ── T3: Complex multi-capability tasks ──
  {
    name: "Architecture design with code",
    expectedTier: 3,
    expectedCapabilities: ["code_generation", "reasoning"],
    request: {
      prompt:
        "Design a rate limiter service for a distributed microservices architecture. Analyze the trade-offs between token bucket and sliding window approaches, then implement the chosen solution in TypeScript with Redis as the backing store. Include the interface definition, core logic, and middleware integration.",
      constraints: { max_tokens: 4096 },
    },
  },
  {
    name: "Complex data analysis",
    expectedTier: 3,
    expectedCapabilities: ["reasoning", "structured_output"],
    request: {
      prompt:
        "Analyze this API performance data and provide a structured JSON report with trend analysis, anomaly detection, and optimization recommendations:\n\n- P50 latency: 45ms (was 30ms last month)\n- P99 latency: 890ms (was 400ms last month)\n- Error rate: 2.3% (was 0.5% last month)\n- Throughput: 12,000 req/s (was 8,000 req/s last month)\n- DB connection pool: 80% utilized\n- Cache hit rate: 67% (was 85% last month)\n- Memory usage: 78% of 16GB\n- CPU: 45% average, 92% peak",
      expected_format: { type: "json" },
    },
  },
  {
    name: "Tool-use scenario",
    expectedTier: 3,
    expectedCapabilities: ["tool_use"],
    request: {
      prompt:
        "I need to build a CLI tool that makes API calls to fetch weather data, processes it, and stores results in a SQLite database. The tool should support function calling to dynamically select which weather metrics to fetch. Describe the architecture and implement the core tool-use dispatch logic.",
    },
  },
  {
    name: "Multi-step reasoning chain",
    expectedTier: 3,
    expectedCapabilities: ["reasoning", "code_generation"],
    request: {
      prompt:
        "A web application is experiencing intermittent 502 errors. The load balancer health checks pass, the application logs show no errors, but nginx access logs show upstream timeouts. The application uses Node.js with a connection pool to PostgreSQL. Analyze the possible root causes step by step, rank them by likelihood, and provide a diagnostic script to identify the actual cause.",
    },
  },

  // ── T4: Maximum complexity ──
  {
    name: "Full system design",
    expectedTier: 4,
    expectedCapabilities: ["reasoning", "code_generation", "structured_output"],
    request: {
      prompt:
        "Design and implement a complete event sourcing system for an e-commerce platform. Include: (1) Event store schema and implementation in TypeScript, (2) Aggregate root pattern with snapshot optimization, (3) Projection builders for read models, (4) Saga pattern for multi-aggregate transactions (order → payment → inventory), (5) Compare this approach against traditional CRUD with a structured analysis of consistency, scalability, and operational complexity trade-offs. Provide working TypeScript code for each component.",
      metadata: { tier: 4 },
      constraints: { max_tokens: 4096, timeout_ms: 60000 },
    },
  },
  {
    name: "Long document analysis",
    expectedTier: 4,
    expectedCapabilities: ["long_context", "reasoning"],
    request: {
      prompt: `Analyze the entire document below and provide a comprehensive evaluation with specific citations:\n\n${"Section " + Array.from({ length: 50 }, (_, i) => `${i + 1}: ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ".repeat(3)}`).join("\n\n")}\n\nProvide: (1) An executive summary, (2) Key themes across all sections, (3) Contradictions or inconsistencies between sections, (4) A structured JSON summary with section-by-section analysis.`,
      metadata: { tier: 4 },
      constraints: { max_tokens: 4096, timeout_ms: 90000 },
    },
  },

  // ── Edge cases ──
  {
    name: "Minimal prompt",
    expectedTier: 1,
    expectedCapabilities: [],
    request: {
      prompt: "Hello",
    },
  },
  {
    name: "Tier override (force T1 on complex prompt)",
    expectedTier: 1,
    expectedCapabilities: ["code_generation", "reasoning"],
    request: {
      prompt: "Analyze and refactor this complex codebase to improve performance",
      metadata: { tier: 1 },
    },
  },
  {
    name: "Explicit capability override",
    expectedTier: 2,
    expectedCapabilities: ["vision"],
    request: {
      prompt: "Describe what you see in this image",
      metadata: { capabilities: ["vision"] },
    },
  },
  {
    name: "Low token budget stress",
    expectedTier: 2,
    expectedCapabilities: ["code_generation"],
    request: {
      prompt: "Implement a binary search function in TypeScript with full error handling",
      constraints: { max_tokens: 256, timeout_ms: 10000 },
    },
  },
  {
    name: "High temperature creative task",
    expectedTier: 1,
    expectedCapabilities: ["summarization"],
    request: {
      prompt:
        "Summarize the concept of quantum computing in a way that would make a 5-year-old laugh",
      constraints: { temperature: 0.9 },
    },
  },
];

// ── Types ──

interface TaskResult {
  task_id: string;
  status: string;
  complexity_tier: number | null;
  selected_agent_id: string | null;
  response_content: string | null;
  cost_usd: number | null;
  latency_ms: number | null;
  error: string | null;
}

interface ScenarioResult {
  scenario: Scenario;
  result: TaskResult | null;
  wallTimeMs: number;
  httpStatus: number | null;
  error: string | null;
}

interface ThresholdCheck {
  name: string;
  limit: number;
  observed: number;
  passed: boolean;
}

interface JsonSummary {
  base_url: string;
  concurrency: number;
  total: number;
  completed: number;
  failed: number;
  errored: number;
  failure_rate: number;
  total_cost_usd: number;
  wall_latency_ms: { p50: number; p95: number; p99: number; max: number };
  api_latency_ms: { p50: number; p95: number; p99: number; max: number };
  per_tier: Record<
    string,
    {
      count: number;
      completed: number;
      cost_usd: number;
      latency_p50_ms: number;
      latency_p95_ms: number;
    }
  >;
  thresholds: ThresholdCheck[];
  ok: boolean;
}

// ── Execution ──

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  return headers;
}

async function submitTask(scenario: Scenario): Promise<ScenarioResult> {
  const start = Date.now();
  // Per-request timeout: a hung server would otherwise stall a worker forever
  // and starve the pool. Add a small buffer over the scenario's own timeout to
  // let server-side timeout handling fire first when possible.
  const scenarioTimeout = scenario.request.constraints?.timeout_ms ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), scenarioTimeout + 5_000);
  try {
    const resp = await fetch(`${BASE_URL}/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(scenario.request),
      signal: controller.signal,
    });
    const body = (await resp.json()) as TaskResult;
    return {
      scenario,
      result: body,
      wallTimeMs: Date.now() - start,
      httpStatus: resp.status,
      error: null,
    };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return {
      scenario,
      result: null,
      wallTimeMs: Date.now() - start,
      httpStatus: null,
      error: aborted ? `client timeout after ${scenarioTimeout + 5_000}ms` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(
  tasks: Scenario[],
  concurrency: number,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const queue = [...tasks];
  let completed = 0;
  const total = tasks.length;

  async function worker() {
    while (queue.length > 0) {
      const scenario = queue.shift()!;
      const result = await submitTask(scenario);
      results.push(result);
      completed++;
      const status = result.result?.status ?? "ERROR";
      const agent = result.result?.selected_agent_id ?? "none";
      const tier = result.result?.complexity_tier ?? "?";
      console.log(
        `  [${completed}/${total}] ${status.padEnd(9)} T${tier} → ${agent.padEnd(20)} ${result.wallTimeMs}ms  ${scenario.name}`,
      );
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Report ──

function generateReport(results: ScenarioResult[]): string {
  const lines: string[] = [];
  const hr = "═".repeat(90);
  const thinHr = "─".repeat(90);

  lines.push("");
  lines.push(hr);
  lines.push("  HAOL LOAD TEST REPORT");
  lines.push(
    `  ${new Date().toISOString()}  |  ${results.length} scenarios  |  concurrency: ${CONCURRENCY}`,
  );
  lines.push(hr);

  const succeeded = results.filter((r) => r.result?.status === "COMPLETED");
  const failed = results.filter((r) => r.result?.status === "FAILED");
  const errored = results.filter((r) => r.error || !r.result?.status);

  lines.push("");
  lines.push("  OVERALL SUMMARY");
  lines.push(thinHr);
  lines.push(
    `  Completed:   ${succeeded.length}/${results.length} (${pct(succeeded.length, results.length)})`,
  );
  lines.push(
    `  Failed:      ${failed.length}/${results.length} (${pct(failed.length, results.length)})`,
  );
  lines.push(
    `  Errors:      ${errored.length}/${results.length} (${pct(errored.length, results.length)})`,
  );

  const totalCost = results.reduce((s, r) => s + (r.result?.cost_usd ?? 0), 0);
  const totalLatency = results.reduce((s, r) => s + (r.result?.latency_ms ?? 0), 0);
  const totalWall = results.reduce((s, r) => s + r.wallTimeMs, 0);

  const wallLatencies = results.map((r) => r.wallTimeMs);
  const apiLatencies = results.map((r) => r.result?.latency_ms ?? 0).filter((n) => n > 0);

  lines.push(`  Total cost:  $${totalCost.toFixed(4)}`);
  lines.push(`  Total API latency: ${totalLatency.toLocaleString()}ms`);
  lines.push(`  Total wall time:   ${totalWall.toLocaleString()}ms`);
  lines.push(
    `  Wall latency — p50: ${percentile(wallLatencies, 50).toFixed(0)}ms  p95: ${percentile(wallLatencies, 95).toFixed(0)}ms  p99: ${percentile(wallLatencies, 99).toFixed(0)}ms`,
  );
  if (apiLatencies.length > 0) {
    lines.push(
      `  API latency  — p50: ${percentile(apiLatencies, 50).toFixed(0)}ms  p95: ${percentile(apiLatencies, 95).toFixed(0)}ms  p99: ${percentile(apiLatencies, 99).toFixed(0)}ms`,
    );
  }

  lines.push("");
  lines.push("  PER-TIER BREAKDOWN");
  lines.push(thinHr);

  for (const tier of [1, 2, 3, 4]) {
    const tierResults = results.filter((r) => r.result?.complexity_tier === tier);
    if (tierResults.length === 0) continue;

    const tierOk = tierResults.filter((r) => r.result?.status === "COMPLETED");
    const latencies = tierOk.map((r) => r.result!.latency_ms!).filter(Boolean);
    const costs = tierOk.map((r) => r.result!.cost_usd!).filter((c) => c != null);

    lines.push(
      `  T${tier}: ${tierResults.length} tasks | ${tierOk.length} completed | ${tierResults.length - tierOk.length} failed`,
    );
    if (latencies.length > 0) {
      lines.push(
        `      Latency  — p50: ${percentile(latencies, 50).toFixed(0)}ms  p95: ${percentile(latencies, 95).toFixed(0)}ms  max: ${Math.max(...latencies)}ms`,
      );
    }
    if (costs.length > 0) {
      lines.push(
        `      Cost     — avg: $${avg(costs).toFixed(4)}  total: $${sum(costs).toFixed(4)}`,
      );
    }

    const agentCounts: Record<string, number> = {};
    for (const r of tierResults) {
      const a = r.result?.selected_agent_id ?? "none";
      agentCounts[a] = (agentCounts[a] ?? 0) + 1;
    }
    lines.push(
      `      Agents   — ${Object.entries(agentCounts)
        .map(([a, c]) => `${a}: ${c}`)
        .join(", ")}`,
    );
    lines.push("");
  }

  lines.push("  AGENT UTILIZATION");
  lines.push(thinHr);

  const agentMap: Record<string, ScenarioResult[]> = {};
  for (const r of results) {
    const a = r.result?.selected_agent_id ?? "unassigned";
    if (!agentMap[a]) agentMap[a] = [];
    agentMap[a].push(r);
  }

  for (const [agent, agentResults] of Object.entries(agentMap).sort()) {
    const ok = agentResults.filter((r) => r.result?.status === "COMPLETED");
    const latencies = ok.map((r) => r.result!.latency_ms!).filter(Boolean);
    const costs = ok.map((r) => r.result!.cost_usd!).filter((c) => c != null);
    lines.push(`  ${agent}`);
    lines.push(
      `    Tasks: ${agentResults.length}  |  Success: ${ok.length}  |  Fail: ${agentResults.length - ok.length}`,
    );
    if (latencies.length > 0) {
      lines.push(
        `    Avg latency: ${avg(latencies).toFixed(0)}ms  |  Avg cost: $${costs.length > 0 ? avg(costs).toFixed(4) : "N/A"}`,
      );
    }
  }

  const failures = results.filter((r) => r.result?.status === "FAILED" || r.error);
  if (failures.length > 0) {
    lines.push("");
    lines.push("  FAILURES & ERRORS");
    lines.push(thinHr);
    for (const r of failures) {
      lines.push(`  ${r.scenario.name}:`);
      if (r.error) lines.push(`    Network error: ${r.error}`);
      if (r.result?.error) lines.push(`    API error: ${r.result.error}`);
      lines.push("");
    }
  }

  lines.push(hr);
  return lines.join("\n");
}

function buildSummary(results: ScenarioResult[], thresholds: ThresholdCheck[]): JsonSummary {
  const succeeded = results.filter((r) => r.result?.status === "COMPLETED");
  const failed = results.filter((r) => r.result?.status === "FAILED");
  const errored = results.filter((r) => r.error || !r.result?.status);
  const total = results.length;

  const wall = results.map((r) => r.wallTimeMs);
  const api = results.map((r) => r.result?.latency_ms ?? 0).filter((n) => n > 0);

  const perTier: JsonSummary["per_tier"] = {};
  for (const tier of [1, 2, 3, 4]) {
    const tierResults = results.filter((r) => r.result?.complexity_tier === tier);
    if (tierResults.length === 0) continue;
    const tierOk = tierResults.filter((r) => r.result?.status === "COMPLETED");
    const latencies = tierOk.map((r) => r.result!.latency_ms!).filter(Boolean);
    const costs = tierOk.map((r) => r.result!.cost_usd ?? 0);
    perTier[`T${tier}`] = {
      count: tierResults.length,
      completed: tierOk.length,
      cost_usd: round4(sum(costs)),
      latency_p50_ms: Math.round(percentile(latencies, 50)),
      latency_p95_ms: Math.round(percentile(latencies, 95)),
    };
  }

  return {
    base_url: BASE_URL,
    concurrency: CONCURRENCY,
    total,
    completed: succeeded.length,
    failed: failed.length,
    errored: errored.length,
    failure_rate: total === 0 ? 0 : round4((failed.length + errored.length) / total),
    total_cost_usd: round4(results.reduce((s, r) => s + (r.result?.cost_usd ?? 0), 0)),
    wall_latency_ms: {
      p50: Math.round(percentile(wall, 50)),
      p95: Math.round(percentile(wall, 95)),
      p99: Math.round(percentile(wall, 99)),
      max: wall.length === 0 ? 0 : Math.max(...wall),
    },
    api_latency_ms: {
      p50: Math.round(percentile(api, 50)),
      p95: Math.round(percentile(api, 95)),
      p99: Math.round(percentile(api, 99)),
      max: api.length === 0 ? 0 : Math.max(...api),
    },
    per_tier: perTier,
    thresholds,
    ok: thresholds.every((t) => t.passed),
  };
}

function evaluateThresholds(results: ScenarioResult[]): ThresholdCheck[] {
  const checks: ThresholdCheck[] = [];
  const total = results.length;
  const failed = results.filter((r) => r.result?.status === "FAILED").length;
  const errored = results.filter((r) => r.error || !r.result?.status).length;

  if (MAX_P95_LATENCY_MS !== undefined) {
    const observed = Math.round(
      percentile(
        results.map((r) => r.wallTimeMs),
        95,
      ),
    );
    checks.push({
      name: "wall_p95_latency_ms",
      limit: MAX_P95_LATENCY_MS,
      observed,
      passed: observed <= MAX_P95_LATENCY_MS,
    });
  }
  if (MAX_COST_USD !== undefined) {
    const observed = round4(results.reduce((s, r) => s + (r.result?.cost_usd ?? 0), 0));
    checks.push({
      name: "total_cost_usd",
      limit: MAX_COST_USD,
      observed,
      passed: observed <= MAX_COST_USD,
    });
  }
  if (MAX_FAILURE_RATE !== undefined) {
    const observed = total === 0 ? 0 : round4((failed + errored) / total);
    checks.push({
      name: "failure_rate",
      limit: MAX_FAILURE_RATE,
      observed,
      passed: observed <= MAX_FAILURE_RATE,
    });
  }
  return checks;
}

// ── Helpers ──

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}
function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function numArg(name: string): number | undefined {
  const v = getArg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) {
    console.error(`Invalid numeric value for ${name}: ${v}`);
    process.exit(2);
  }
  return n;
}

// ── Main ──

async function main() {
  console.log(`\nHAOL Load Test`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Scenarios: ${scenarios.length}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (API_KEY) console.log(`  Auth: Bearer (HAOL_API_KEY supplied)`);
  console.log("");

  try {
    const healthResp = await fetch(`${BASE_URL}/health`);
    if (!healthResp.ok) {
      console.error(`Health check failed: HTTP ${healthResp.status}`);
      process.exit(1);
    }
    console.log("  Health check: OK\n");
  } catch (e: any) {
    console.error(`Cannot reach HAOL at ${BASE_URL}: ${e.message}`);
    console.error("  Start the server with: npm run dev");
    process.exit(1);
  }

  console.log("  Running scenarios...\n");
  const results = await runWithConcurrency(scenarios, CONCURRENCY);
  const report = generateReport(results);
  console.log(report);

  const thresholds = evaluateThresholds(results);
  if (thresholds.length > 0) {
    console.log("");
    console.log("  THRESHOLDS");
    console.log("  " + "─".repeat(88));
    for (const t of thresholds) {
      const status = t.passed ? "PASS" : "FAIL";
      console.log(`  [${status}] ${t.name}: observed ${t.observed} (limit ${t.limit})`);
    }
  }

  if (EMIT_JSON) {
    const summary = buildSummary(results, thresholds);
    console.log("");
    console.log("HAOL_LOAD_TEST_JSON " + JSON.stringify(summary));
  }

  const failedThreshold = thresholds.some((t) => !t.passed);
  if (failedThreshold) {
    console.error("\nThreshold violation — exiting with code 1");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
