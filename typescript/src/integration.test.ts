/**
 * Integration tests — verify full SDK flow and API contract.
 * Type tests — verify TypeScript typings compile correctly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { configure, getConfig } from "./config.js";
import { record, trace, TraceRecorder } from "./recorder.js";
import { SpanType, TraceStatus } from "./trace.js";
import type { SpanData, TraceData } from "./trace.js";

beforeEach(() => {
  configure({ apiKey: "rt_live_integration", baseUrl: "http://localhost:3001", wsUrl: "", projectId: undefined, enabled: true });
});

// ─── TYPE TESTS (compile-time verification) ────────────────────────────────

describe("Type Safety", () => {
  it("Config interface is correct", () => {
    const cfg = getConfig();
    expect(typeof cfg.apiKey).toBe("string");
    expect(typeof cfg.baseUrl).toBe("string");
    expect(typeof cfg.wsUrl).toBe("string");
    expect(typeof cfg.enabled).toBe("boolean");
  });

  it("SpanData type is correct", () => {
    const span: SpanData = {
      id: "test",
      name: "test",
      spanType: SpanType.LLM_CALL,
      startedAt: new Date().toISOString(),
    };
    expect(span.id).toBe("test");
  });

  it("TraceData type is correct", () => {
    const trace: TraceData = {
      id: "test",
      name: "test",
      status: TraceStatus.RUNNING,
      startedAt: new Date().toISOString(),
      spans: [],
    };
    expect(trace.status).toBe("running");
  });

  it("TraceRecorder accepts correct options", () => {
    const rec = new TraceRecorder({ name: "typed", metadata: { key: "value" } });
    rec.start();
    const data = rec.builder.toDict();
    expect(data.name).toBe("typed");
  });
});

// ─── API CONTRACT ──────────────────────────────────────────────────────────

describe("API Contract", () => {
  it("trace payload has required fields", () => {
    const rec = new TraceRecorder({ name: "contract" });
    rec.start();
    rec.end("output");
    const data = rec.builder.toDict();

    // Required by POST /api/v1/traces
    expect(data.id).toBeDefined();
    expect(typeof data.id).toBe("string");
    expect(data.name).toBe("contract");
    expect(data.status).toBe("completed");
    expect(data.started_at).toBeDefined();
    expect(data.spans).toBeInstanceOf(Array);
  });

  it("span payload has required fields", () => {
    const rec = new TraceRecorder({ name: "span-contract" });
    rec.start();
    const span = rec.startSpan("my-span", SpanType.LLM_CALL, { messages: [] });
    rec.endSpan(span, "response");
    const data = rec.builder.toDict();
    const s = data.spans[0];

    expect(s.id).toBeDefined();
    expect(s.name).toBe("my-span");
    expect(s.span_type).toBe("llm_call");
    expect(s.started_at).toBeDefined();
    expect(s.input).toEqual({ messages: [] });
    expect(s.output).toBe("response");
  });

  it("trace function wrapper works", () => {
    const myAgent = trace((prompt: string) => {
      return `Hello ${prompt}`;
    }, { name: "trace-wrapper" });

    const result = myAgent("world");
    expect(result).toBe("Hello world");
  });

  it("record function creates recorder", () => {
    const rec = record({ name: "record-test" });
    expect(rec).toBeInstanceOf(TraceRecorder);
    rec.start();
    rec.end("done");
  });
});

// ─── EXPORTS ───────────────────────────────────────────────────────────────

describe("Package Exports", () => {
  it("all public APIs are exported from index", async () => {
    const sdk = await import("./index.js");
    expect(sdk.configure).toBeDefined();
    expect(sdk.getConfig).toBeDefined();
    expect(sdk.record).toBeDefined();
    expect(sdk.trace).toBeDefined();
    expect(sdk.TraceRecorder).toBeDefined();
    expect(sdk.SpanType).toBeDefined();
    expect(sdk.TraceStatus).toBeDefined();
    expect(sdk.SpanBuilder).toBeDefined();
    expect(sdk.TraceBuilder).toBeDefined();
    expect(sdk.installGeminiInterceptor).toBeDefined();
    expect(sdk.installOpenAIInterceptor).toBeDefined();
    expect(sdk.installAnthropicInterceptor).toBeDefined();
  });
});
