import { Writable } from "node:stream";

/**
 * Pino numeric log levels. Pino emits these as the `level` field on every
 * record. The values themselves are stable across pino major versions, but
 * raw numbers in test assertions are unreadable — prefer these constants.
 */
export const LogLevel = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
} as const;

export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Writable stream that buffers everything pino writes to it and parses each
 * line as JSON on demand. Pair with `_setDestinationForTests(capture)` to
 * redirect the logger inside a test, then assert on `capture.records()`.
 */
export class CaptureStream extends Writable {
  lines: string[] = [];

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.lines.push(chunk.toString());
    cb();
  }

  /**
   * Returns parsed log records, optionally filtered to a single level. Pass
   * a `LogLevel.*` constant rather than the raw number for readability.
   */
  records(level?: LogLevelValue): Array<Record<string, unknown>> {
    const recs = this.lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return level === undefined ? recs : recs.filter((r) => r.level === level);
  }
}

/**
 * Snapshot the current `LOG_LEVEL` env var, set it to a desired value, and
 * return a restore function. Pair the call inside `beforeEach` with the
 * returned restore inside `afterEach` so a thrown test cannot leak the env
 * mutation into the next test or suite.
 */
export function setLogLevel(level: string): () => void {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  return () => {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  };
}
