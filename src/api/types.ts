/**
 * Shared Hono environment for the HAOL API. Anything threaded through
 * `c.set` / `c.get` belongs here so the typed key surface stays in one place
 * and renames are caught at compile time.
 */
export type HonoEnv = {
  Variables: {
    requestId: string;
  };
};
