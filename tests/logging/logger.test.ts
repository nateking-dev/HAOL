import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger, _setDestinationForTests } from "../../src/logging/logger.js";
import { runWithContext, getContext } from "../../src/logging/context.js";
import { CaptureStream, LogLevel, setLogLevel } from "../helpers/capture-stream.js";

let capture: CaptureStream;
let restoreLogLevel: () => void;

beforeEach(() => {
  capture = new CaptureStream();
  // The logger is built lazily under the test stream; level=trace forces
  // every method to emit so we can assert against any call.
  restoreLogLevel = setLogLevel("trace");
  _setDestinationForTests(capture);
});

afterEach(() => {
  _setDestinationForTests(undefined);
  restoreLogLevel();
});

describe("logger", () => {
  it("emits JSON lines with the message and service base", () => {
    logger.info("hello world");
    const recs = capture.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ msg: "hello world", service: "haol" });
  });

  it("merges per-call fields into the record", () => {
    logger.warn("rate limited", { route: "/v1/tasks", retry_after: 5 });
    const [rec] = capture.records();
    expect(rec).toMatchObject({
      msg: "rate limited",
      route: "/v1/tasks",
      retry_after: 5,
      level: LogLevel.WARN,
    });
  });

  it("includes AsyncLocalStorage context (request_id) on every log inside runWithContext", () => {
    runWithContext({ request_id: "req-abc" }, () => {
      logger.info("inside");
    });
    logger.info("outside");

    const recs = capture.records();
    expect(recs[0]).toMatchObject({ msg: "inside", request_id: "req-abc" });
    expect(recs[1].request_id).toBeUndefined();
  });

  it("merges nested contexts (request_id + task_id)", () => {
    runWithContext({ request_id: "req-1" }, () => {
      runWithContext({ task_id: "task-9" }, () => {
        logger.info("worker tick");
      });
    });

    const [rec] = capture.records();
    expect(rec).toMatchObject({
      msg: "worker tick",
      request_id: "req-1",
      task_id: "task-9",
    });
  });

  it("isolates contexts across concurrent async tasks", async () => {
    const a = runWithContext({ request_id: "req-A" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      logger.info("from A");
      return getContext().request_id;
    });
    const b = runWithContext({ request_id: "req-B" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      logger.info("from B");
      return getContext().request_id;
    });

    const [rA, rB] = await Promise.all([a, b]);
    expect(rA).toBe("req-A");
    expect(rB).toBe("req-B");

    // Both records exist and each carries its own request_id, regardless
    // of completion order.
    const recs = capture.records();
    const byMsg = new Map(recs.map((r) => [r.msg, r] as const));
    expect(byMsg.get("from A")?.request_id).toBe("req-A");
    expect(byMsg.get("from B")?.request_id).toBe("req-B");
  });

  it("per-call fields override context fields with the same key", () => {
    runWithContext({ request_id: "from-context" }, () => {
      logger.info("override", { request_id: "from-call" });
    });
    const [rec] = capture.records();
    expect(rec.request_id).toBe("from-call");
  });
});
