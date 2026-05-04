import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import { getContext } from "./context.js";

type Fields = Record<string, unknown>;
type LogMethod = (msg: string, fields?: Fields) => void;

export interface Logger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}

let destination: DestinationStream | undefined;
let root: PinoLogger = createRoot();

function defaultLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (process.env.NODE_ENV === "test") return "silent";
  if (process.env.NODE_ENV === "production") return "info";
  return "debug";
}

function createRoot(): PinoLogger {
  // Sync destination keeps logs flushed before process.exit on fatal paths.
  // Volume here is event-level (boot, errors, worker transitions), not request-
  // level, so the perf cost is negligible and the simplicity is worth it.
  const dest = destination ?? pino.destination({ sync: true });
  return pino({ level: defaultLevel(), base: { service: "haol" } }, dest);
}

function method(level: keyof PinoLogger): LogMethod {
  return (msg, fields) => {
    const merged = { ...getContext(), ...(fields ?? {}) };
    (root[level] as (obj: object, msg: string) => void).call(root, merged, msg);
  };
}

export const logger: Logger = {
  trace: method("trace"),
  debug: method("debug"),
  info: method("info"),
  warn: method("warn"),
  error: method("error"),
  fatal: method("fatal"),
};

/** Test hook — redirect log output to a custom stream and rebuild the root. */
export function _setDestinationForTests(dest: DestinationStream | undefined): void {
  destination = dest;
  root = createRoot();
}
