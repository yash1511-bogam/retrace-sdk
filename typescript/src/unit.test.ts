import { describe, it, expect, beforeEach } from "vitest";
import { configure, getConfig, requireApiKey } from "./config.js";
import { TraceRecorder } from "./recorder.js";
import { SpanType, TraceStatus } from "./trace.js";

beforeEach(() => {
  // Reset config
  configure({ apiKey: "", baseUrl: "http://localhost:3001", wsUrl: "", projectId: undefined, enabled: true });
});

// ─── AUTH ───────────────────────────────────────────────────────────────────

describe("Auth", () => {
  it("accepts valid rt_live_ key", () => {
    configure({ apiKey: "rt_live_abc123" });
    expect(getConfig().apiKey).toBe("rt_live_abc123");
  });

  it("throws on invalid key prefix", () => {
    expect(() => configure({ apiKey: "sk-invalid" })).toThrow("rt_live_");
  });

  it("allows empty key at configure time", () => {
    configure({ apiKey: "" });
    expect(getConfig().apiKey).toBe("");
  });

  it("requireApiKey throws when no key set", () => {
    configure({ apiKey: "" });
    expect(() => requireApiKey()).toThrow("Retrace API key required");
  });

  it("requireApiKey returns key when set", () => {
    configure({ apiKey: "rt_live_test" });
    expect(requireApiKey()).toBe("rt_live_test");
  });

  it("recorder throws without API key", () => {
    configure({ apiKey: "" });
    expect(() => new TraceRecorder({ name: "test" })).toThrow("Retrace API key required");
  });
});

// ─── CONFIGURATION ─────────────────────────────────────────────────────────

describe("Configuration", () => {
  it("derives wsUrl from baseUrl", () => {
    configure({ apiKey: "rt_live_x", baseUrl: "https://api.example.com" });
    expect(getConfig().wsUrl).toBe("wss://api.example.com");
  });

  it("http baseUrl becomes ws", () => {
    configure({ apiKey: "rt_live_x", baseUrl: "http://localhost:3001" });
    expect(getConfig().wsUrl).toBe("ws://localhost:3001");
  });

  it("respects projectId", () => {
    configure({ apiKey: "rt_live_x", projectId: "proj-123" });
    expect(getConfig().projectId).toBe("proj-123");
  });

  it("respects enabled flag", () => {
    configure({ apiKey: "rt_live_x", enabled: false });
    expect(getConfig().enabled).toBe(false);
  });
});

// ─── SERIALIZATION ─────────────────────────────────────────────────────────

describe("Serialization", () => {
  it("recorder creates trace with correct name", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "my-trace" });
    rec.start();
    const data = rec.builder.toDict();
    expect(data.name).toBe("my-trace");
    expect(data.status).toBe(TraceStatus.RUNNING);
  });

  it("spans have correct types", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "span-test" });
    rec.start();
    const span = rec.startSpan("llm-call", SpanType.LLM_CALL, { messages: [] });
    expect(span.data.span_type).toBe("llm_call");
    rec.endSpan(span, "response");
    const data = rec.builder.toDict();
    expect(data.spans!.length).toBe(1);
    expect(data.spans![0].output).toBe("response");
  });

  it("metadata is preserved", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "meta", metadata: { env: "test", version: 2 } });
    rec.start();
    const data = rec.builder.toDict();
    expect(data.metadata).toEqual({ env: "test", version: 2 });
  });
});

// ─── INVALID INPUTS ────────────────────────────────────────────────────────

describe("Invalid Inputs", () => {
  it("SpanType enum values are correct", () => {
    expect(SpanType.LLM_CALL).toBe("llm_call");
    expect(SpanType.TOOL_CALL).toBe("tool_call");
    expect(SpanType.ERROR).toBe("error");
  });

  it("TraceStatus enum values are correct", () => {
    expect(TraceStatus.RUNNING).toBe("running");
    expect(TraceStatus.COMPLETED).toBe("completed");
    expect(TraceStatus.FAILED).toBe("failed");
  });
});

// ─── RECORDER LIFECYCLE ────────────────────────────────────────────────────

describe("Recorder Lifecycle", () => {
  it("start sets startedAt", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "lifecycle" });
    rec.start();
    const data = rec.builder.toDict();
    expect(data.started_at).toBeDefined();
  });

  it("end sets status to completed", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "lifecycle" });
    rec.start();
    rec.end("output");
    const data = rec.builder.toDict();
    expect(data.status).toBe(TraceStatus.COMPLETED);
    expect(data.output).toBe("output");
  });

  it("error sets status to failed", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "lifecycle" });
    rec.start();
    rec.end(undefined, TraceStatus.FAILED);
    const data = rec.builder.toDict();
    expect(data.status).toBe(TraceStatus.FAILED);
  });

  it("multiple spans tracked", () => {
    configure({ apiKey: "rt_live_test" });
    const rec = new TraceRecorder({ name: "multi" });
    rec.start();
    const s1 = rec.startSpan("s1", SpanType.LLM_CALL);
    rec.endSpan(s1, "r1");
    const s2 = rec.startSpan("s2", SpanType.TOOL_CALL);
    rec.endSpan(s2, "r2");
    rec.end("done");
    const data = rec.builder.toDict();
    expect(data.spans!.length).toBe(2);
  });
});
