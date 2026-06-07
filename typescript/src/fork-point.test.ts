import { describe, it, expect, vi, beforeAll } from "vitest";
import { configure } from "./config.js";
import { TraceRecorder } from "./recorder.js";
import { TraceStatus } from "./trace.js";
import type { SpanData } from "./trace.js";

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));
  configure({ apiKey: "rt_live_testkey", transport: "http", baseUrl: "http://127.0.0.1:0" });
});

function mkSpan(n: number): SpanData {
  return { id: `s${n}`, trace_id: "", parent_id: null, span_type: "llm_call", name: `span-${n}`, started_at: new Date().toISOString() } as unknown as SpanData;
}

function spyStarts(rec: TraceRecorder) {
  // The recorder holds a shared Transport instance; count the span_started emissions it makes.
  const spy = vi.spyOn((rec as unknown as { transport: { send: (e: string, d: unknown) => void } }).transport, "send");
  return { spy, count: () => spy.mock.calls.filter((c) => c[0] === "span_started").length };
}

describe("fork-point positional suppression", () => {
  it("suppresses the pre-fork spans (counter <= index) and emits from the fork point onward", () => {
    const rec = new TraceRecorder({ name: "fork", input: null, forkPointSpanId: "orig-3", forkPointIndex: 2 });
    rec.start("fork", null);
    const { spy, count } = spyStarts(rec);
    for (let i = 1; i <= 5; i++) rec.addSpan(mkSpan(i));
    expect(count()).toBe(3); // index 2 ⇒ suppress 1,2; emit 3,4,5
    spy.mockRestore();
    rec.end(undefined, TraceStatus.COMPLETED);
  });

  it("emits every span when no fork index is given (normal recording)", () => {
    const rec = new TraceRecorder({ name: "normal", input: null });
    rec.start("normal", null);
    const { spy, count } = spyStarts(rec);
    for (let i = 1; i <= 4; i++) rec.addSpan(mkSpan(i));
    expect(count()).toBe(4);
    spy.mockRestore();
    rec.end(undefined, TraceStatus.COMPLETED);
  });
});
