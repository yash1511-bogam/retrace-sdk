import { describe, it, expect, vi, beforeAll } from "vitest";
import { configure } from "./config.js";
import { TraceRecorder } from "./recorder.js";
import { TraceStatus } from "./trace.js";

// No real network: streaming-span finalization (two-phase) must not depend on a live transport.
beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));
  configure({ apiKey: "rt_live_testkey", transport: "http", baseUrl: "http://127.0.0.1:0" });
});

describe("two-phase streaming spans (OpenSpanSink)", () => {
  it("finalizes a still-open streaming span as 'partial' at trace end (no silent loss)", () => {
    const rec = new TraceRecorder({ name: "t", input: null });
    rec.start("t", null);
    const finalize = vi.fn();
    rec.registerOpenSpan("stream-1", finalize);
    // The consumer never drained the stream — end the trace with it still open.
    rec.end(undefined, TraceStatus.COMPLETED);
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith("partial");
  });

  it("does NOT finalize a span that already closed (unregistered)", () => {
    const rec = new TraceRecorder({ name: "t", input: null });
    rec.start("t", null);
    const finalize = vi.fn();
    rec.registerOpenSpan("stream-2", finalize);
    rec.unregisterOpenSpan("stream-2"); // stream drained/broke in-band and emitted itself
    rec.end(undefined, TraceStatus.COMPLETED);
    expect(finalize).not.toHaveBeenCalled();
  });
});
