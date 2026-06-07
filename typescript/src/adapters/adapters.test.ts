import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub transport so recorders never open a socket.
vi.mock("../transport.js", () => ({ createTransport: () => ({ send: vi.fn(), close: vi.fn(), flush: vi.fn() }), registerProcessExitFlush: vi.fn(), onProcessExit: vi.fn() }));

import { configure } from "../config.js";
import { TraceRecorder } from "../recorder.js";
import { recordVercelStep } from "./vercel-ai.js";
import { createLangChainHandler } from "./langchain.js";

describe("Vercel AI adapter", () => {
  beforeEach(() => configure({ apiKey: "rt_live_test", enabled: true }));

  it("records an llm span + tool_call + tool_result into the recorder", () => {
    const rec = new TraceRecorder({ name: "t" });
    rec.start("t");
    const addSpan = vi.spyOn(rec, "addSpan");
    const startSpan = vi.spyOn(rec, "startSpan");
    recordVercelStep(
      {
        text: "hi",
        usage: { promptTokens: 5, completionTokens: 3 },
        toolCalls: [{ toolName: "search", args: { q: "x" } }],
        toolResults: [{ toolName: "search", result: "ok" }],
      },
      rec,
    );
    expect(addSpan).toHaveBeenCalledTimes(1); // llm span (carries token usage)
    expect(startSpan).toHaveBeenCalledTimes(2); // tool_call + tool_result
    const llmSpan = addSpan.mock.calls[0][0];
    expect(llmSpan.span_type).toBe("llm_call");
    expect(llmSpan.input_tokens).toBe(5);
    expect(llmSpan.output_tokens).toBe(3);
  });

  it("no-ops without an active recorder", () => {
    expect(() => recordVercelStep({ text: "x" })).not.toThrow();
  });
});

describe("LangChain adapter", () => {
  it("throws a helpful error when @langchain/core is not installed", async () => {
    await expect(createLangChainHandler()).rejects.toThrow(/@langchain\/core/);
  });
});
