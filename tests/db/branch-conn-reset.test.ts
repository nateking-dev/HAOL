import { describe, it, expect } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import {
  setAutocommit,
  noteConnectionBranch,
  connectionNeedsReset,
  DEFAULT_BRANCH,
} from "../../src/db/connection.js";

// These tests exercise the per-connection reset tracking that lets
// withBranchConnection skip redundant `SET @@autocommit = 1` / DOLT_CHECKOUT
// round-trips (audit M23 / issue #78). They use a fake connection that just
// records queries, so they run without a live Dolt server.

interface FakeConn {
  queries: string[];
  query(sql: string): Promise<[never[], never[]]>;
  // isPoolConnection() distinguishes a single connection from a Pool by the
  // presence of release(), so the fake must expose it to be tracked.
  release(): void;
}

function fakeConn(): FakeConn & PoolConnection {
  const conn: FakeConn = {
    queries: [],
    async query(sql: string) {
      conn.queries.push(sql);
      return [[], []];
    },
    release() {},
  };
  return conn as unknown as FakeConn & PoolConnection;
}

describe("branch-connection reset tracking", () => {
  it("treats an untracked connection conservatively (both resets needed)", () => {
    const conn = fakeConn();
    expect(connectionNeedsReset(conn)).toEqual({ autocommit: true, checkout: true });
  });

  it("skips both resets after a clean callback (autocommit on, on default branch)", async () => {
    const conn = fakeConn();
    // Mirrors createSession: force autocommit on, stay on the default branch.
    await setAutocommit(conn, true);
    noteConnectionBranch(conn, DEFAULT_BRANCH);

    expect(connectionNeedsReset(conn)).toEqual({ autocommit: false, checkout: false });
  });

  it("flags the checkout reset when the connection is left off the default branch", async () => {
    const conn = fakeConn();
    await setAutocommit(conn, true);
    noteConnectionBranch(conn, "session/abc");

    expect(connectionNeedsReset(conn)).toEqual({ autocommit: false, checkout: true });
  });

  it("flags the autocommit reset when the callback leaves autocommit disabled", async () => {
    const conn = fakeConn();
    await setAutocommit(conn, false);
    noteConnectionBranch(conn, DEFAULT_BRANCH);

    expect(connectionNeedsReset(conn)).toEqual({ autocommit: true, checkout: false });
  });

  it("tracks the writeContext sequence and ends clean", async () => {
    const conn = fakeConn();
    // Entry: autocommit on, checkout session branch.
    await setAutocommit(conn, true);
    noteConnectionBranch(conn, "session/task-1");
    // Group the commit under autocommit=0.
    await setAutocommit(conn, false);
    // finally: restore autocommit, return to main.
    await setAutocommit(conn, true);
    noteConnectionBranch(conn, DEFAULT_BRANCH);

    expect(connectionNeedsReset(conn)).toEqual({ autocommit: false, checkout: false });
  });

  it("setAutocommit issues the correct SQL", async () => {
    const conn = fakeConn();
    await setAutocommit(conn, true);
    await setAutocommit(conn, false);
    expect(conn.queries).toEqual(["SET @@autocommit = 1", "SET @@autocommit = 0"]);
  });

  it("noteConnectionBranch ignores a Pool (no release method)", () => {
    // A Pool isn't a single connection; tracking must not throw or record state.
    const pool = { query: async () => [[], []] } as unknown as PoolConnection;
    expect(() => noteConnectionBranch(pool, "session/x")).not.toThrow();
    // Still reported as conservatively needing resets (no state recorded).
    expect(connectionNeedsReset(pool)).toEqual({ autocommit: true, checkout: true });
  });
});
