import { describe, it, expect, beforeEach } from "vitest";
import {
  parseToolArgs,
  resetToolResultDedup,
  emitOpenAIToolCalls,
  emitOpenAIToolResults,
  emitAnthropicToolCalls,
  emitAnthropicToolResults,
  emitGeminiToolCalls,
  emitGeminiToolResults,
  extractSamplingParams,
} from "./tool-spans.js";
import { SpanData, SpanType } from "../trace.js";

function collector() {
  const spans: SpanData[] = [];
  return { spans, emit: (s: SpanData) => spans.push(s) };
}

describe("tool-span extraction (Phase 1C)", () => {
  beforeEach(() => resetToolResultDedup());

  it("parseToolArgs parses JSON strings into structured objects, leaves objects untouched", () => {
    expect(parseToolArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
    expect(parseToolArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolArgs("not json")).toBe("not json");
  });

  it("OpenAI: an agent calling 3 tools produces 3 tool_call + 3 tool_result spans", () => {
    const model = "gpt-5.5";
    // The model's response requesting 3 tool calls
    const responseMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"weather"}' } },
        { id: "call_2", type: "function", function: { name: "lookup", arguments: '{"id":42}' } },
        { id: "call_3", type: "function", function: { name: "compute", arguments: '{"x":1}' } },
      ],
    };
    const tc = collector();
    emitOpenAIToolCalls(responseMessage, "llm-span", model, tc.emit);
    expect(tc.spans).toHaveLength(3);
    expect(tc.spans.every((s) => s.span_type === SpanType.TOOL_CALL)).toBe(true);
    expect(tc.spans[0]).toMatchObject({ name: "search", parent_id: "llm-span", model });
    // Arguments captured as STRUCTURED JSON, not a string
    expect(tc.spans[0].input).toEqual({ q: "weather" });
    expect(tc.spans[0].metadata).toMatchObject({ tool_call_id: "call_1" });

    // The follow-up request feeds back 3 tool results
    const followupMessages = [
      { role: "user", content: "go" },
      responseMessage,
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      { role: "tool", tool_call_id: "call_2", content: "found" },
      { role: "tool", tool_call_id: "call_3", content: "2" },
    ];
    const tr = collector();
    emitOpenAIToolResults(followupMessages, tr.emit);
    expect(tr.spans).toHaveLength(3);
    expect(tr.spans.every((s) => s.span_type === SpanType.TOOL_RESULT)).toBe(true);
    // tool name resolved from the assistant tool_calls, result captured verbatim
    expect(tr.spans[0]).toMatchObject({ name: "search", output: "sunny" });
    expect(tr.spans[0].metadata).toMatchObject({ tool_call_id: "call_1" });
  });

  it("OpenAI: tool_result spans are deduped across repeated requests (no double-count)", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const a = collector();
    emitOpenAIToolResults(messages, a.emit);
    expect(a.spans).toHaveLength(1);
    // Same tool message present again on the next turn → must NOT re-emit
    const b = collector();
    emitOpenAIToolResults(messages, b.emit);
    expect(b.spans).toHaveLength(0);
  });

  it("OpenAI: a tool result containing an error is flagged as an error span", () => {
    const messages = [
      { role: "assistant", tool_calls: [{ id: "e1", function: { name: "fetch", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e1", content: "Error: connection failed" },
    ];
    const c = collector();
    emitOpenAIToolResults(messages, c.emit);
    expect(c.spans).toHaveLength(1);
    expect(c.spans[0].error).toBe("Error: connection failed");
  });

  it("Anthropic: tool_use blocks → tool_call spans; tool_result blocks → tool_result spans", () => {
    const content = [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "tu_1", name: "weather", input: { city: "NYC" } },
    ];
    const tc = collector();
    emitAnthropicToolCalls(content, "llm", "claude-opus-4.7", tc.emit);
    expect(tc.spans).toHaveLength(1);
    expect(tc.spans[0]).toMatchObject({ name: "weather", input: { city: "NYC" }, span_type: SpanType.TOOL_CALL });

    const messages = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "rainy", is_error: false }] },
    ];
    const tr = collector();
    emitAnthropicToolResults(messages, tr.emit);
    expect(tr.spans).toHaveLength(1);
    expect(tr.spans[0]).toMatchObject({ output: "rainy", span_type: SpanType.TOOL_RESULT });
  });

  it("Gemini: functionCall parts → tool_call spans; functionResponse parts → tool_result spans", () => {
    const candidates = [{ content: { parts: [{ functionCall: { name: "geocode", args: { addr: "x" } } }] } }];
    const tc = collector();
    emitGeminiToolCalls(candidates, "llm", "gemini-3-pro", tc.emit);
    expect(tc.spans).toHaveLength(1);
    expect(tc.spans[0]).toMatchObject({ name: "geocode", input: { addr: "x" }, span_type: SpanType.TOOL_CALL });

    const contents = [{ parts: [{ functionResponse: { name: "geocode", id: "fr1", response: { lat: 1 } } }] }];
    const tr = collector();
    emitGeminiToolResults(contents, tr.emit);
    expect(tr.spans).toHaveLength(1);
    expect(tr.spans[0]).toMatchObject({ name: "geocode", output: { lat: 1 }, span_type: SpanType.TOOL_RESULT });
  });

  it("emits nothing when there are no tool calls (plain completion)", () => {
    const c = collector();
    emitOpenAIToolCalls({ role: "assistant", content: "hi" }, "llm", "gpt-5.5", c.emit);
    emitAnthropicToolCalls([{ type: "text", text: "hi" }], "llm", "claude", c.emit);
    emitGeminiToolCalls([{ content: { parts: [{ text: "hi" }] } }], "llm", "gemini", c.emit);
    expect(c.spans).toHaveLength(0);
  });
});

describe("extractSamplingParams", () => {
  it("normalizes OpenAI sampling params", () => {
    expect(extractSamplingParams("openai", { temperature: 0.7, top_p: 0.9, seed: 42, max_tokens: 500 }))
      .toEqual({ temperature: 0.7, top_p: 0.9, seed: 42, max_tokens: 500 });
  });
  it("normalizes Anthropic (top_k, max_tokens)", () => {
    expect(extractSamplingParams("anthropic", { temperature: 0.2, top_k: 40, max_tokens: 1024 }))
      .toEqual({ temperature: 0.2, top_k: 40, max_tokens: 1024 });
  });
  it("reads Gemini params from config + camelCase", () => {
    expect(extractSamplingParams("gemini", { config: { temperature: 1, topP: 0.95, maxOutputTokens: 256 } }))
      .toEqual({ temperature: 1, top_p: 0.95, max_tokens: 256 });
  });
  it("returns undefined when no params set", () => {
    expect(extractSamplingParams("openai", { model: "gpt-5.5", messages: [] })).toBeUndefined();
  });
});
