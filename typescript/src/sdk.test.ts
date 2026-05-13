import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, getConfig } from "./config.js";

// Reset config between tests
beforeEach(() => {
  configure({ apiKey: "", baseUrl: "http://localhost:3001", enabled: true, wsUrl: "" });
});

describe("Config", () => {
  it("has sensible defaults", () => {
    const c = getConfig();
    expect(c.baseUrl).toBe("http://localhost:3001");
    expect(c.enabled).toBe(true);
  });

  it("configures custom values", () => {
    configure({ apiKey: "rt_live_test", baseUrl: "https://api.example.com" });
    const c = getConfig();
    expect(c.apiKey).toBe("rt_live_test");
    expect(c.baseUrl).toBe("https://api.example.com");
    expect(c.wsUrl).toBe("wss://api.example.com");
  });

  it("auto-derives wsUrl from baseUrl", () => {
    configure({ baseUrl: "https://custom.io" });
    expect(getConfig().wsUrl).toBe("wss://custom.io");
    configure({ baseUrl: "http://localhost:3001" });
    expect(getConfig().wsUrl).toBe("ws://localhost:3001");
  });

  it("throws on invalid API key prefix", () => {
    expect(() => configure({ apiKey: "invalid_key" })).toThrow("rt_live_");
  });

  it("does not warn on valid API key", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    configure({ apiKey: "rt_live_valid123" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("Trace model", () => {
  it("SpanBuilder creates valid span data", async () => {
    const { SpanBuilder, SpanType } = await import("./trace.js");
    const sb = new SpanBuilder("test-span", SpanType.LLM_CALL).start();
    sb.setModel("gpt-4o");
    sb.setInput({ prompt: "hi" });
    const data = sb.end("hello");
    expect(data.name).toBe("test-span");
    expect(data.span_type).toBe("llm_call");
    expect(data.model).toBe("gpt-4o");
    expect(data.output).toBe("hello");
    expect(data.id).toHaveLength(36);
    expect(data.started_at).toBeDefined();
    expect(data.ended_at).toBeDefined();
  });

  it("TraceBuilder creates valid trace data", async () => {
    const { TraceBuilder, TraceStatus } = await import("./trace.js");
    const tb = new TraceBuilder();
    tb.start("my-trace", { prompt: "test" });
    const data = tb.end("result", TraceStatus.COMPLETED);
    expect(data.name).toBe("my-trace");
    expect(data.status).toBe("completed");
    expect(data.output).toBe("result");
    expect(data.id).toHaveLength(36);
  });

  it("SpanType enum values", async () => {
    const { SpanType } = await import("./trace.js");
    expect(SpanType.LLM_CALL).toBe("llm_call");
    expect(SpanType.TOOL_CALL).toBe("tool_call");
    expect(SpanType.ERROR).toBe("error");
    expect(SpanType.FORK_POINT).toBe("fork_point");
  });
});

describe("Recorder", () => {
  it("trace() wraps sync function", async () => {
    configure({ apiKey: "rt_live_t", baseUrl: "http://x:1", enabled: true });
    const { trace } = await import("./recorder.js");
    const fn = trace((x: unknown) => `result:${x}`, { name: "sync-fn" });
    expect(fn("hi")).toBe("result:hi");
  });

  it("trace() wraps async function", async () => {
    configure({ apiKey: "rt_live_t", baseUrl: "http://x:1", enabled: true });
    const { trace } = await import("./recorder.js");
    const fn = trace(async (x: unknown) => `async:${x}`, { name: "async-fn" });
    const result = await fn("hi");
    expect(result).toBe("async:hi");
  });

  it("trace() propagates exceptions", async () => {
    configure({ apiKey: "rt_live_t", baseUrl: "http://x:1", enabled: true });
    const { trace } = await import("./recorder.js");
    const fn = trace(() => { throw new Error("boom"); }, { name: "err-fn" });
    expect(() => fn()).toThrow("boom");
  });

  it("disabled SDK is no-op", async () => {
    configure({ apiKey: "rt_live_t", enabled: false });
    const { trace } = await import("./recorder.js");
    const fn = trace((x: unknown) => `r:${x}`, { name: "off" });
    expect(fn("hi")).toBe("r:hi");
  });
});

describe("Transport", () => {
  it("HTTPTransport accumulates and flushes", async () => {
    configure({ apiKey: "rt_live_t", baseUrl: "http://x:1" });
    const { HTTPTransport } = await import("./transport.js");
    const http = new HTTPTransport();

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    http.send("trace_started", { id: "abc", name: "t", status: "running", started_at: "2026-01-01T00:00:00Z", total_tokens: 0, total_cost: 0, total_duration_ms: 0 });
    http.send("span_started", { id: "s1", trace_id: "abc", span_type: "llm_call", name: "s", started_at: "2026-01-01T00:00:00Z" });
    http.send("span_ended", { id: "s1", ended_at: "2026-01-01T00:00:01Z", output: "hi" });
    http.send("trace_ended", { id: "abc", ended_at: "2026-01-01T00:00:02Z", status: "completed" });

    expect(mockFetch).toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.id).toBe("abc");
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].output).toBe("hi");

    vi.unstubAllGlobals();
  });

  it("createTransport returns correct type", async () => {
    const { createTransport, HTTPTransport } = await import("./transport.js");
    expect(createTransport("http")).toBeInstanceOf(HTTPTransport);
  });
});

describe("README examples", () => {
  it("TypeScript README example works", async () => {
    configure({ apiKey: "rt_live_test", enabled: false });
    const { trace } = await import("./recorder.js");
    const runAgent = trace(async (prompt: unknown) => {
      return `Response to: ${prompt}`;
    }, { name: "my-agent" });
    const result = await runAgent("What is quantum computing?");
    expect(result).toContain("quantum");
  });
});
