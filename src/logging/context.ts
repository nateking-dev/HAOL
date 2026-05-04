import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  request_id?: string;
  task_id?: string;
  component?: string;
  [key: string]: unknown;
}

const als = new AsyncLocalStorage<LogContext>();

export function getContext(): LogContext {
  return als.getStore() ?? {};
}

/**
 * Run `fn` with a merged log context. Bindings shallow-merge over any
 * outer context — request handlers establish `{ request_id }`, the worker
 * later layers `{ task_id }` on top, and individual logs may add more.
 */
export function runWithContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(als.getStore() ?? {}), ...ctx };
  return als.run(merged, fn);
}
