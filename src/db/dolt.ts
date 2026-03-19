import { getPool, withConnection, type Queryable } from "./connection.js";

export interface DoltCommitOptions {
  message: string;
  author?: string;
  allowEmpty?: boolean;
}

export async function doltCommit(opts: DoltCommitOptions, conn?: Queryable): Promise<string> {
  const db = conn ?? getPool();
  const args: string[] = ["-m", opts.message];
  if (opts.author) {
    args.push("--author", opts.author);
  }
  if (opts.allowEmpty) {
    args.push("--allow-empty");
  }

  // DOLT_COMMIT with -A flag to auto-stage all changes
  const placeholders = args.map(() => "?").join(", ");
  const [rows] = await db.query(`CALL DOLT_COMMIT('-A', ${placeholders})`, args);
  const result = rows as Record<string, string>[];
  return result[0]?.hash ?? "";
}

/**
 * Switch the connection to a different Dolt branch.
 * `conn` is required because DOLT_CHECKOUT mutates session state;
 * running it on an arbitrary pool connection would corrupt that
 * connection for subsequent callers.
 */
export async function doltCheckout(branch: string, conn: Queryable): Promise<void> {
  await conn.query("CALL DOLT_CHECKOUT(?)", [branch]);
}

export interface DoltBranchOptions {
  name: string;
  startPoint?: string;
}

export async function doltBranch(opts: DoltBranchOptions, conn?: Queryable): Promise<void> {
  const db = conn ?? getPool();
  if (opts.startPoint) {
    await db.query("CALL DOLT_BRANCH(?, ?)", [opts.name, opts.startPoint]);
  } else {
    await db.query("CALL DOLT_BRANCH(?)", [opts.name]);
  }
}

export async function doltDeleteBranch(name: string, conn?: Queryable): Promise<void> {
  const db = conn ?? getPool();
  await db.query("CALL DOLT_BRANCH('-d', ?)", [name]);
}

export interface DoltMergeResult {
  hash: string;
  fastForward: boolean;
  conflicts: number;
}

/**
 * Merge a branch into the current branch.
 * `conn` is required because DOLT_MERGE mutates the working set of
 * the session's active branch; using a random pool connection could
 * merge into the wrong branch.
 */
export async function doltMerge(branch: string, conn: Queryable): Promise<DoltMergeResult> {
  const [rows] = await conn.query("CALL DOLT_MERGE(?)", [branch]);
  const result = rows as Record<string, unknown>[];
  const row = result[0] ?? {};
  return {
    hash: (row.hash as string) ?? "",
    fastForward: (row.fast_forward as number) === 1,
    conflicts: (row.conflicts as number) ?? 0,
  };
}

export async function doltActiveBranch(conn?: Queryable): Promise<string> {
  const db = conn ?? getPool();
  const [rows] = await db.query("SELECT active_branch() AS branch");
  const result = rows as Record<string, string>[];
  return result[0]?.branch ?? "main";
}

/**
 * Best-effort Dolt commit on a dedicated connection.
 * Acquires its own connection from the pool so the commit targets the
 * correct (main) branch regardless of pool connection state.
 * Silently ignores "nothing to commit" errors.
 */
export async function commitSafely(
  message: string,
  author: string = "haol-system <haol@system>",
  allowEmpty: boolean = false,
): Promise<void> {
  await withConnection(async (conn) => {
    try {
      await doltCommit({ message, author, allowEmpty }, conn);
    } catch (err) {
      if (!(err as Error).message?.includes("nothing to commit")) {
        throw err;
      }
    }
  });
}
