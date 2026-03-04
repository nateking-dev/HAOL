import { query, getPool } from "../db/connection.js";
import { doltDeleteBranch } from "../db/dolt.js";
import type { RowDataPacket } from "mysql2/promise";

interface BranchRow extends RowDataPacket {
  name: string;
  latest_commit_date: string;
}

export async function pruneSessionBranches(
  retentionDays: number,
): Promise<string[]> {
  const pool = getPool();

  // Query dolt_branches for session/* branches
  const [rows] = await pool.query<BranchRow[]>(
    `SELECT name, latest_commit_date FROM dolt_branches WHERE name LIKE 'session/%'`,
  );

  const cutoff = retentionDays > 0
    ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    : null; // null means prune all
  const pruned: string[] = [];

  for (const row of rows) {
    const shouldPrune = cutoff === null
      || new Date(row.latest_commit_date) <= cutoff;
    if (shouldPrune) {
      try {
        await doltDeleteBranch(row.name);
        pruned.push(row.name);
      } catch {
        // Branch may have already been deleted or is checked out
      }
    }
  }

  return pruned;
}
