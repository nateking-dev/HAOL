import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPool, getPool, destroy } from "./connection.js";
import { doltCommit, isNothingToCommitError } from "./dolt.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS migrations_applied (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    sha256 CHAR(64) NOT NULL,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  )
`;

// MySQL error codes that are recoverable when a previous migration run
// partially applied a file before crashing — re-running picks up where
// it left off without operator intervention. See execStatementsIdempotent.
const RECOVERABLE_DDL_ERRNOS = new Set<number>([
  1050, // ER_TABLE_EXISTS_ERROR — CREATE TABLE re-run
  1060, // ER_DUP_FIELDNAME    — ADD COLUMN re-run
  1061, // ER_DUP_KEYNAME      — CREATE INDEX / ADD INDEX re-run
]);

// Dolt collapses these into errno 1105 (ER_UNKNOWN_ERROR), preserving the
// message text. Match the message so re-runs against Dolt also recover.
const RECOVERABLE_DDL_MESSAGE_PATTERNS: RegExp[] = [
  /column ".+" already exists/i, // dup ADD COLUMN
  /duplicate column name/i, // alt phrasing
  /duplicate key name/i, // dup CREATE INDEX / ADD INDEX
  /table .+ already exists/i, // dup CREATE TABLE without IF NOT EXISTS
];

// Known-safe edits to previously-applied migrations: filename → set of
// pre-edit SHAs the drift detector should auto-upgrade instead of throwing.
// Each entry is a deliberate operator-facing decision: the SHA drift check
// exists to catch silent edits, so we only allowlist edits that are
// semantically equivalent on a fully-applied schema.
//
// Current entries: PR for finding #8 added `IF NOT EXISTS` to `CREATE INDEX`
// in migrations 017 and 019 so that a crash mid-migration recovers cleanly.
const TOLERATED_DRIFT: Map<string, ReadonlySet<string>> = new Map([
  [
    "017_add_missing_indexes.sql",
    new Set(["873803b5e9adc248f51fae4d4fb2e0b98a625a966040178fb3e3fd5eff40d8cd"]),
  ],
  [
    "019_async_task_pipeline.sql",
    new Set(["515e44eb8ab8d77501bc11c823a70b410107fb92b62d52b036e7475be7b9ea2e"]),
  ],
]);

interface AppliedRow {
  filename: string;
  sha256: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Split a SQL file into individual statements. Quote- and comment-aware so
 * a `;` inside a string literal or `/* ... *\/` block doesn't fragment a
 * statement (the historical naive `split(";")` did exactly that).
 *
 * Not a full SQL parser — does not handle DELIMITER changes (stored procs)
 * or backslash-escaped quotes. Sufficient for the schema migrations this
 * file applies; document the limitation if a future migration needs more.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      buf += c;
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === "*" && next === "/") {
        buf += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'" && next === "'") {
        // SQL '' escape inside a single-quoted literal — consume both.
        buf += next;
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && next === '"') {
        buf += next;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      buf += c;
      if (c === "`") inBacktick = false;
      continue;
    }

    if (c === "-" && next === "-") {
      inLineComment = true;
      buf += c;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      buf += c + next;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === "`") {
      inBacktick = true;
      buf += c;
      continue;
    }
    if (c === ";") {
      const s = buf.trim();
      if (s.length > 0) out.push(s);
      buf = "";
      continue;
    }
    buf += c;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

async function loadAppliedRows(): Promise<Map<string, string>> {
  const pool = getPool();
  const [rows] = (await pool.query("SELECT filename, sha256 FROM migrations_applied")) as [
    AppliedRow[],
    unknown,
  ];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.filename, row.sha256);
  return map;
}

async function legacySchemaExists(): Promise<boolean> {
  const pool = getPool();
  // agent_registry is created by 001_create_agent_registry.sql — its presence
  // signals that this DB was already migrated before tracking was introduced.
  const [rows] = (await pool.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_registry' LIMIT 1`,
  )) as [unknown[], unknown];
  return rows.length > 0;
}

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const pool = getPool();

  await pool.query(TRACKING_DDL);

  const applied = await loadAppliedRows();

  // Warn on tracked files that have disappeared from disk. Operators may
  // intentionally delete archived migrations (so warn rather than throw),
  // but a silent accidental deletion would hide the fact that part of the
  // applied schema no longer has a source-of-truth file.
  const onDisk = new Set(files);
  for (const recorded of applied.keys()) {
    if (!onDisk.has(recorded)) {
      console.warn("[migrate] applied migration %s no longer exists on disk", recorded);
    }
  }

  // One-time backfill: if tracking is empty but the schema is already
  // populated, this DB pre-dates the tracking table. Stamp every current
  // file as applied so we don't re-run non-idempotent ALTERs (e.g. 011's
  // ADD COLUMN without IF NOT EXISTS) and trip on duplicate-column errors.
  //
  // The insert is a single multi-row statement so a crash mid-backfill
  // can't leave tracking partially populated — partial rows would defeat
  // the `applied.size === 0` guard on the next run, causing un-stamped
  // files to be treated as "new" and re-executed.
  if (applied.size === 0 && (await legacySchemaExists())) {
    console.log("[migrate] existing schema detected — backfilling migrations_applied");
    const rows: [string, string][] = [];
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      rows.push([file, sha256(sql)]);
    }
    await pool.query("INSERT INTO migrations_applied (filename, sha256) VALUES ?", [rows]);
    return [];
  }

  const ran: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const hash = sha256(sql);
    const recordedHash = applied.get(file);

    if (recordedHash) {
      if (recordedHash !== hash) {
        const tolerated = TOLERATED_DRIFT.get(file);
        if (tolerated && tolerated.has(recordedHash)) {
          // Known-safe edit (e.g., added `IF NOT EXISTS` for crash-recovery).
          // Upgrade the tracking row instead of throwing.
          console.log(
            "[migrate] tolerated drift on %s: rehashing %s… → %s…",
            file,
            recordedHash.slice(0, 12),
            hash.slice(0, 12),
          );
          await pool.query("UPDATE migrations_applied SET sha256 = ? WHERE filename = ?", [
            hash,
            file,
          ]);
          continue;
        }
        throw new Error(
          `Migration ${file} has drifted: applied SHA ${recordedHash.slice(0, 12)}… ` +
            `does not match disk SHA ${hash.slice(0, 12)}…. ` +
            `Revert the file or write a new migration instead of editing applied SQL.`,
        );
      }
      continue;
    }

    // Atomicity: DDL auto-commits in MySQL/Dolt, so a crash between the
    // last statement and the tracking INSERT below leaves the schema
    // mutated but unrecorded. On the next run the file is treated as new
    // and re-executed; execStatementsIdempotent catches the recoverable
    // duplicate-* errors so re-execution succeeds without operator
    // intervention. Migrations that introduce non-DDL writes should still
    // be designed idempotently (INSERT IGNORE / ON DUPLICATE KEY UPDATE).
    await execStatementsIdempotent(file, splitStatements(sql));

    await pool.query("INSERT INTO migrations_applied (filename, sha256) VALUES (?, ?)", [
      file,
      hash,
    ]);
    ran.push(file);
  }

  return ran;
}

interface MysqlError extends Error {
  errno?: number;
}

async function execStatementsIdempotent(file: string, statements: string[]): Promise<void> {
  const pool = getPool();
  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (err) {
      const e = err as MysqlError;
      if (isRecoverableDuplicateDdl(e)) {
        console.warn(
          "[migrate] %s: skipping already-applied statement (errno=%d): %s",
          file,
          e.errno,
          firstLine(statement),
        );
        continue;
      }
      throw err;
    }
  }
}

function isRecoverableDuplicateDdl(err: MysqlError): boolean {
  if (err.errno != null && RECOVERABLE_DDL_ERRNOS.has(err.errno)) return true;
  // Dolt path: errno 1105 with the duplicate-* message preserved.
  const msg = err.message ?? "";
  return RECOVERABLE_DDL_MESSAGE_PATTERNS.some((re) => re.test(msg));
}

function firstLine(sql: string): string {
  const line = sql.split("\n", 1)[0].trim();
  return line.length > 120 ? line.slice(0, 117) + "..." : line;
}

// CLI entry point
async function main() {
  const config = loadConfig();
  try {
    getPool();
  } catch {
    createPool(config.dolt);
  }

  console.log("Running migrations...");
  const ran = await runMigrations();
  if (ran.length === 0) {
    console.log("  no new migrations to apply.");
  } else {
    for (const file of ran) {
      console.log("  applied: %s", file);
    }
  }

  try {
    await doltCommit({
      message: "migration: initial schema",
      author: "haol-migrate <haol@system>",
    });
    console.log("Dolt commit created.");
  } catch (err) {
    if (isNothingToCommitError(err)) {
      console.log("No changes to commit (already up to date).");
    } else {
      throw err;
    }
  }

  await destroy();
}

// Only run main when executed directly (not imported)
const isMain = process.argv[1]?.includes("migrate");
if (isMain) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
