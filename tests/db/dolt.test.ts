import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, getPool, destroy, withBranchConnection } from "../../src/db/connection.js";
import {
  doltCommit,
  doltCheckout,
  doltBranch,
  doltDeleteBranch,
  doltMerge,
  doltActiveBranch,
} from "../../src/db/dolt.js";
import { loadConfig } from "../../src/config.js";

let doltAvailable = false;

beforeAll(async () => {
  const config = loadConfig();
  try {
    try {
      getPool();
    } catch {
      createPool(config.dolt);
    }
    const pool = getPool();
    await pool.query("SELECT 1");
    doltAvailable = true;
  } catch (err) {
    console.warn("Dolt not available — skipping dolt integration tests");
    console.warn("Error:", (err as Error).message);
  }
});

afterAll(async () => {
  await destroy();
});

describe("dolt helpers", () => {
  it("doltActiveBranch returns current branch", async ({ skip }) => {
    if (!doltAvailable) skip();
    const branch = await doltActiveBranch();
    expect(branch).toBe("main");
  });

  it("doltCommit creates a commit with allow-empty", async ({ skip }) => {
    if (!doltAvailable) skip();
    const hash = await doltCommit({
      message: "test: empty commit from vitest",
      author: "haol-test <test@haol>",
      allowEmpty: true,
    });
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
  });

  it("doltBranch + doltCheckout + doltMerge lifecycle", async ({ skip }) => {
    if (!doltAvailable) skip();
    const testBranch = `test/story0-${Date.now()}`;

    await withBranchConnection(async (conn) => {
      // Create and switch to branch
      await doltBranch({ name: testBranch }, conn);
      await doltCheckout(testBranch, conn);

      const activeBranch = await doltActiveBranch(conn);
      expect(activeBranch).toBe(testBranch);

      // Make a commit on the branch
      await doltCommit(
        {
          message: "test: commit on branch",
          author: "haol-test <test@haol>",
          allowEmpty: true,
        },
        conn,
      );

      // Switch back and merge
      await doltCheckout("main", conn);
      const mergeResult = await doltMerge(testBranch, conn);
      expect(mergeResult.conflicts).toBe(0);

      // Cleanup
      await doltDeleteBranch(testBranch, conn);
    });
  });
});
