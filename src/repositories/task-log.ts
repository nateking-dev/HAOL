import { getPool } from "../db/connection.js";
import { query } from "../db/connection.js";
import type { RowDataPacket } from "mysql2/promise";
import type { TaskStatus } from "../types/router.js";

interface TaskLogRow extends RowDataPacket {
  task_id: string;
  // mysql2 deserialises TIMESTAMP as a JS Date (no dateStrings on the pool).
  created_at: string | Date;
  status: string;
  prompt_hash: string | null;
  prompt: string | null;
  input_metadata: string | Record<string, unknown> | null;
  input_constraints: string | Record<string, unknown> | null;
  complexity_tier: number | null;
  required_capabilities: string | string[] | null;
  cost_ceiling_usd: string | number | null;
  selected_agent_id: string | null;
  selection_rationale: string | Record<string, unknown> | null;
  routing_confidence: number | null;
  routing_layer: string | null;
  expected_format: string | Record<string, unknown> | null;
  worker_started_at: string | null;
  worker_finished_at: string | null;
  worker_error: string | null;
  response_content: string | null;
}

export interface TaskLogRecord {
  task_id: string;
  // Date at runtime (mysql2 deserialises TIMESTAMP without dateStrings); typed
  // as the union so consumers that page on it (see QueuedCursor) are honest.
  created_at: string | Date;
  status: TaskStatus;
  prompt_hash: string | null;
  prompt: string | null;
  input_metadata: Record<string, unknown> | null;
  input_constraints: Record<string, unknown> | null;
  complexity_tier: number | null;
  required_capabilities: string[] | null;
  cost_ceiling_usd: number | null;
  selected_agent_id: string | null;
  selection_rationale: Record<string, unknown> | null;
  routing_confidence: number | null;
  routing_layer: string | null;
  expected_format: Record<string, unknown> | null;
  worker_started_at: string | null;
  worker_finished_at: string | null;
  worker_error: string | null;
  response_content: string | null;
}

function parseRow(row: TaskLogRow): TaskLogRecord {
  let capabilities: string[] | null = null;
  if (row.required_capabilities) {
    if (typeof row.required_capabilities === "string") {
      try {
        capabilities = JSON.parse(row.required_capabilities);
      } catch {
        capabilities = null;
      }
    } else {
      capabilities = row.required_capabilities;
    }
  }

  let rationale: Record<string, unknown> | null = null;
  if (row.selection_rationale) {
    if (typeof row.selection_rationale === "string") {
      try {
        rationale = JSON.parse(row.selection_rationale);
      } catch {
        rationale = null;
      }
    } else {
      rationale = row.selection_rationale as Record<string, unknown>;
    }
  }

  let expectedFormat: Record<string, unknown> | null = null;
  if (row.expected_format) {
    if (typeof row.expected_format === "string") {
      try {
        expectedFormat = JSON.parse(row.expected_format);
      } catch {
        expectedFormat = null;
      }
    } else {
      expectedFormat = row.expected_format as Record<string, unknown>;
    }
  }

  const parseJsonColumn = (
    val: string | Record<string, unknown> | null,
  ): Record<string, unknown> | null => {
    if (val == null) return null;
    if (typeof val !== "string") return val;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  };

  return {
    task_id: row.task_id,
    created_at: row.created_at,
    status: row.status as TaskStatus,
    prompt_hash: row.prompt_hash,
    prompt: row.prompt,
    input_metadata: parseJsonColumn(row.input_metadata),
    input_constraints: parseJsonColumn(row.input_constraints),
    complexity_tier: row.complexity_tier,
    required_capabilities: capabilities,
    cost_ceiling_usd:
      row.cost_ceiling_usd != null
        ? typeof row.cost_ceiling_usd === "string"
          ? parseFloat(row.cost_ceiling_usd)
          : row.cost_ceiling_usd
        : null,
    selected_agent_id: row.selected_agent_id,
    selection_rationale: rationale,
    routing_confidence: row.routing_confidence,
    routing_layer: row.routing_layer,
    expected_format: expectedFormat,
    worker_started_at: row.worker_started_at,
    worker_finished_at: row.worker_finished_at,
    worker_error: row.worker_error,
    response_content: row.response_content,
  };
}

export async function create(taskId: string, promptHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_log (task_id, status, prompt_hash) VALUES (?, 'RECEIVED', ?)`,
    [taskId, promptHash],
  );
}

export interface QueuedTaskInput {
  prompt: string;
  metadata?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  expected_format?: Record<string, unknown>;
}

/**
 * Async-pipeline intake: insert a row in QUEUED status with the full input
 * stashed so a worker (or the reaper, after a crash) can run the pipeline
 * later. Distinct from create() so the legacy synchronous CLI path is
 * untouched.
 */
export async function createQueued(
  taskId: string,
  promptHash: string,
  input: QueuedTaskInput,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO task_log
       (task_id, status, prompt_hash, prompt, input_metadata, input_constraints, expected_format)
     VALUES (?, 'QUEUED', ?, ?, ?, ?, ?)`,
    [
      taskId,
      promptHash,
      input.prompt,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.constraints ? JSON.stringify(input.constraints) : null,
      input.expected_format ? JSON.stringify(input.expected_format) : null,
    ],
  );
}

/**
 * Worker pickup: transition QUEUED → RECEIVED and stamp worker_started_at.
 * Conditional on QUEUED so a duplicate enqueue (e.g. reaper racing a live
 * worker) cannot kick off a second execution. Returns true if this caller
 * acquired the row.
 */
export async function claimQueued(taskId: string): Promise<boolean> {
  const pool = getPool();
  const [result] = await pool.query(
    `UPDATE task_log
       SET status = 'RECEIVED',
           worker_started_at = CURRENT_TIMESTAMP
     WHERE task_id = ? AND status = 'QUEUED'`,
    [taskId],
  );
  return (result as { affectedRows: number }).affectedRows === 1;
}

export async function recordWorkerError(taskId: string, message: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
       SET status = 'FAILED',
           worker_error = ?,
           worker_finished_at = CURRENT_TIMESTAMP
     WHERE task_id = ?`,
    [message.slice(0, 65535), taskId],
  );
}

/**
 * Atomic terminal-state writes for the async pipeline. Combining
 * status/response_content/finished-stamp into a single UPDATE prevents a
 * polling client from observing `done: true` with `response_content` still
 * null between two separate writes.
 */
export async function markCompleted(taskId: string, responseContent: string | null): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
       SET status = 'COMPLETED',
           response_content = ?,
           worker_finished_at = CURRENT_TIMESTAMP
     WHERE task_id = ?`,
    [responseContent, taskId],
  );
}

export async function markFailed(taskId: string, errorMessage?: string | null): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
       SET status = 'FAILED',
           worker_error = COALESCE(?, worker_error),
           worker_finished_at = CURRENT_TIMESTAMP
     WHERE task_id = ?`,
    [errorMessage ? errorMessage.slice(0, 65535) : null, taskId],
  );
}

interface StaleTaskRow extends RowDataPacket {
  task_id: string;
}

/**
 * Reaper query: find rows that have been sitting in non-terminal in-flight
 * states longer than maxAgeSeconds. QUEUED is excluded — it's handled
 * separately by findQueuedPage() since it's safe to retry.
 *
 * Age is measured from worker pickup (`worker_started_at`), not intake
 * (`created_at`). A row that sat in QUEUED for an hour before a worker
 * claimed it is healthy work, not a crashed worker. COALESCE falls back
 * to created_at for any row that predates migration 019 or somehow
 * reached an in-flight state without claimQueued() stamping the column.
 *
 * Returns only task_ids — the reaper does not need prompt/metadata/etc.
 * for these rows (it just marks them FAILED + deletes the session branch),
 * and SELECT * would pull the LONGTEXT prompt for every stale row.
 */
export async function findStale(maxAgeSeconds: number): Promise<string[]> {
  const rows = await query<StaleTaskRow[]>(
    `SELECT task_id FROM task_log
       WHERE status IN ('RECEIVED','CLASSIFIED','DISPATCHED')
         AND COALESCE(worker_started_at, created_at) < (NOW() - INTERVAL ? SECOND)
       ORDER BY COALESCE(worker_started_at, created_at) ASC`,
    [maxAgeSeconds],
  );
  return rows.map((r) => r.task_id);
}

/**
 * Keyset cursor for paging through QUEUED rows in (created_at, task_id) order.
 * `created_at` matches TaskLogRecord.created_at (a Date at runtime) and is bound
 * through unchanged. task_log.created_at is whole-second precision, so the Date
 * round-trips to the exact stored value when mysql2 re-serializes it for the
 * bound parameter.
 */
export interface QueuedCursor {
  created_at: string | Date;
  task_id: string;
}

/**
 * Returns one page of currently-QUEUED rows ordered by (created_at, task_id)
 * ascending. Used at startup to re-enqueue tasks that arrived while the worker
 * was down.
 *
 * Paged (keyset, not OFFSET) so the reaper never loads the entire backlog —
 * including every row's `prompt` LONGTEXT — into memory at once. A boot-time
 * surge of large prompts would otherwise risk OOM. The reaper must still pull
 * the prompt/metadata columns (it reconstructs the full job to re-enqueue), so
 * the protection is bounding the *page*, not dropping columns.
 *
 * The (created_at, task_id) tuple is unique (task_id is the PK), so the keyset
 * predicate never skips or repeats a row even when many tasks share a
 * created_at. The `idx_task_log_status_created (status, created_at)` index
 * from migration 019 supports the WHERE+ORDER BY prefix.
 *
 * Pass the last row of the previous page as `after` to fetch the next page;
 * a page shorter than `limit` means the queue is drained.
 */
export async function findQueuedPage(
  limit: number,
  after?: QueuedCursor,
): Promise<TaskLogRecord[]> {
  const params: (string | number | Date)[] = [];
  let cursorClause = "";
  if (after) {
    cursorClause = "AND (created_at > ? OR (created_at = ? AND task_id > ?))";
    params.push(after.created_at, after.created_at, after.task_id);
  }
  params.push(limit);
  const rows = await query<TaskLogRow[]>(
    `SELECT * FROM task_log
       WHERE status = 'QUEUED' ${cursorClause}
       ORDER BY created_at ASC, task_id ASC
       LIMIT ?`,
    params,
  );
  return rows.map(parseRow);
}

export async function updateClassification(
  taskId: string,
  tier: number,
  capabilities: string[],
  costCeiling: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
     SET status = 'CLASSIFIED',
         complexity_tier = ?,
         required_capabilities = ?,
         cost_ceiling_usd = ?
     WHERE task_id = ?`,
    [tier, JSON.stringify(capabilities), costCeiling, taskId],
  );
}

export async function updateSelection(
  taskId: string,
  agentId: string,
  rationale: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log
     SET status = 'DISPATCHED',
         selected_agent_id = ?,
         selection_rationale = ?
     WHERE task_id = ?`,
    [agentId, JSON.stringify(rationale), taskId],
  );
}

/**
 * Generic status writer. Does NOT stamp worker_finished_at — terminal
 * transitions in the async pipeline must use markCompleted/markFailed so
 * status, response, and finish-stamp land in a single UPDATE. This keeps
 * worker_finished_at meaningful: a row with worker_started_at IS NULL but
 * worker_finished_at IS NOT NULL would be confusing in observability dashboards.
 */
export async function updateStatus(taskId: string, status: TaskStatus): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE task_log SET status = ? WHERE task_id = ?`, [status, taskId]);
}

export async function findById(taskId: string): Promise<TaskLogRecord | null> {
  const rows = await query<TaskLogRow[]>("SELECT * FROM task_log WHERE task_id = ?", [taskId]);
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}

export async function updateRoutingConfidence(
  taskId: string,
  confidence: number,
  layer: string | undefined,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE task_log SET routing_confidence = ?, routing_layer = ? WHERE task_id = ?`,
    [confidence, layer ?? null, taskId],
  );
}

export async function updateExpectedFormat(
  taskId: string,
  formatSpec: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE task_log SET expected_format = ? WHERE task_id = ?`, [
    JSON.stringify(formatSpec),
    taskId,
  ]);
}
