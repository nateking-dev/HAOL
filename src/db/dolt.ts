import { getPool, type Queryable } from "./connection.js";

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

export async function doltCheckout(branch: string, conn?: Queryable): Promise<void> {
  const db = conn ?? getPool();
  await db.query("CALL DOLT_CHECKOUT(?)", [branch]);
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

export async function doltMerge(branch: string, conn?: Queryable): Promise<DoltMergeResult> {
  const db = conn ?? getPool();
  const [rows] = await db.query("CALL DOLT_MERGE(?)", [branch]);
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
