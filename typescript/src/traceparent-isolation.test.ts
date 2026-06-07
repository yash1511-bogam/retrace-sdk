import { describe, it, expect, beforeAll, vi } from "vitest";
import { trace, TraceRecorder } from "./recorder.js";
import { getTraceparent, parseTraceparent } from "./traceparent.js";
import { configure } from "./config.js";

// Configure a test key with the HTTP transport and stub fetch, so trace_started/ended "sends" go to
// a no-op mock — these tests touch NO real network while exercising the real trace()/recorder paths.
beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));
  configure({ apiKey: "rt_live_testkey", transport: "http", baseUrl: "http://127.0.0.1:0" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read this execution context's traceparent trace-id (32hex), or null. */
function currentTid(): string | null {
  const tp = getTraceparent();
  return tp ? parseTraceparent(tp)!.traceId : null;
}

describe("traceparent isolation under GENUINE interleaved concurrency", () => {
  it("trace() HOF: N concurrent traces, interleaved awaits — every read is OWN trace, all unique", async () => {
    const N = 12;
    // Each traced fn reads getTraceparent() at 3 interleaved await points; we assert every read
    // equals THIS trace's id (captured at entry), proving no cross-context leakage.
    const runOne = (i: number) =>
      trace(async () => {
        const mine = currentTid();
        const reads: (string | null)[] = [mine];
        for (let k = 0; k < 3; k++) {
          await sleep(Math.random() * 8); // random → forces genuine interleaving across branches
          reads.push(currentTid());
        }
        return { mine, reads };
      }, { name: `hof-${i}` })();

    const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));

    const tids = results.map((r) => r.mine);
    // Every read within a trace matches that trace's own id (zero cross-assignment).
    for (const r of results) {
      expect(r.mine).toBeTruthy();
      for (const got of r.reads) expect(got).toBe(r.mine);
    }
    // Uniqueness: no two concurrent traces share a trace-id (no shared RNG/counter collision).
    expect(new Set(tids).size).toBe(N);
  });

  it("imperative TraceRecorder start/end: SEQUENTIAL cycles each read their OWN context (no global leak)", async () => {
    // The bare imperative path (record()/new TraceRecorder) has no async scope to bind, so it is
    // NOT concurrency-isolated — trace() is the concurrency-safe API. What it MUST guarantee is that
    // sequential start→…→end cycles each see their own traceparent and never leak a stale global
    // into the next cycle (the old setTraceContext-global bug). Verify that contract.
    const tids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const rec = new TraceRecorder({ name: `imp-${i}`, input: {} });
      rec.start(`imp-${i}`, {});
      const own = rec.traceId.replace(/-/g, "");
      expect(currentTid()).toBe(own);
      await sleep(2);
      expect(currentTid()).toBe(own); // survives an await within the cycle
      rec.end(undefined);
      // After end(), the context is cleared — the NEXT cycle must not inherit this one's id.
      expect(currentTid()).toBeNull();
      tids.push(own);
    }
    expect(new Set(tids).size).toBe(8); // unique
  });

  it("uniqueness: 200 trace-ids generated in a tight loop never collide", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = new TraceRecorder({ name: "u", input: {} });
      ids.add(r.traceId);
    }
    expect(ids.size).toBe(200);
  });
});

describe("imperative record(): never-silent concurrency guard", () => {
  it("OVERLAPPING imperative start() loudly warns (corruption → loud signal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new TraceRecorder({ name: "a", input: {} });
    const b = new TraceRecorder({ name: "b", input: {} });
    a.start("a", {});
    b.start("b", {}); // starts while `a` is still active → must warn
    const warned = warn.mock.calls.some((c) => String(c[0]).includes("CONCURRENT imperative record()"));
    expect(warned).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("trace()"))).toBe(true); // blesses trace()
    a.end(undefined);
    b.end(undefined);
    warn.mockRestore();
  });

  it("SEQUENTIAL imperative start/end does NOT warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const r = new TraceRecorder({ name: `s${i}`, input: {} });
      r.start(`s${i}`, {});
      r.end(undefined);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("CONCURRENT imperative"))).toBe(false);
    warn.mockRestore();
  });

  it("concurrent trace() HOF does NOT warn (managed/isolated path)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await Promise.all([0, 1, 2, 3].map((i) => trace(async () => { await sleep(3); return i; }, { name: `m${i}` })()));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("CONCURRENT imperative"))).toBe(false);
    warn.mockRestore();
  });
});
