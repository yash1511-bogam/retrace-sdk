import { SpanType } from "../trace.js";
import { getActiveRecorder } from "../init.js";
import type { TraceRecorder } from "../recorder.js";
import type { SpanBuilder } from "../trace.js";

/**
 * LangChain / LangGraph adapter for Retrace (JS).
 *
 * Returns a LangChain `BaseCallbackHandler` that records STRUCTURED tool / retriever / chain spans
 * into the active Retrace trace, aligned with the detectors. LLM spans are already captured by the
 * provider interceptors, so this handler does not emit `llm_call` spans.
 *
 * ```ts
 * import { init } from "retrace-sdk";
 * import { createLangChainHandler } from "retrace-sdk/adapters/langchain";
 * init();
 * const cb = await createLangChainHandler();
 * await app.invoke(input, { callbacks: [cb] });   // works for LangChain + LangGraph
 * ```
 */
export async function createLangChainHandler(recorder?: TraceRecorder): Promise<object> {
  let BaseCallbackHandler: new (...args: unknown[]) => object;
  try {
    ({ BaseCallbackHandler } = await import("@langchain/core/callbacks/base"));
  } catch {
    throw new Error("@langchain/core is not installed. Run: npm install @langchain/core");
  }

  const open = new Map<string, SpanBuilder>();
  const rec = (): TraceRecorder | null => recorder ?? getActiveRecorder();

  class RetraceHandler extends BaseCallbackHandler {
    name = "retrace";

    handleToolStart(tool: { name?: string } | undefined, input: string, runId: string): void {
      const r = rec(); if (!r) return;
      open.set(runId, r.startSpan(tool?.name || "tool", SpanType.TOOL_CALL, input));
    }
    handleToolEnd(output: unknown, runId: string): void {
      const r = rec(); if (!r) return;
      const sb = open.get(runId);
      if (sb) { r.endSpan(sb, output); open.delete(runId); }
      const tr = r.startSpan("tool_result", SpanType.TOOL_RESULT);
      r.endSpan(tr, output);
    }
    handleToolError(err: unknown, runId: string): void {
      const r = rec(); if (!r) return;
      const sb = open.get(runId);
      if (sb) { r.endSpan(sb, undefined, err instanceof Error ? err.message : String(err)); open.delete(runId); }
    }

    handleRetrieverStart(_retriever: unknown, query: string, runId: string): void {
      const r = rec(); if (!r) return;
      open.set(runId, r.startSpan("retrieval", SpanType.ACTION, query));
    }
    handleRetrieverEnd(documents: Array<{ pageContent?: string }>, runId: string): void {
      const r = rec(); if (!r) return;
      const sb = open.get(runId);
      if (sb) {
        const docs = (documents || []).map((d) => d?.pageContent ?? JSON.stringify(d));
        r.endSpan(sb, { count: docs.length, documents: docs });
        open.delete(runId);
      }
    }

    handleChainStart(chain: { id?: string[]; name?: string } | undefined, inputs: unknown, runId: string): void {
      const r = rec(); if (!r) return;
      const name = chain?.name || chain?.id?.[chain.id.length - 1] || "chain";
      open.set(runId, r.startSpan(String(name), SpanType.REASONING, inputs));
    }
    handleChainEnd(outputs: unknown, runId: string): void {
      const r = rec(); if (!r) return;
      const sb = open.get(runId);
      if (sb) { r.endSpan(sb, outputs); open.delete(runId); }
    }
    handleChainError(err: unknown, runId: string): void {
      const r = rec(); if (!r) return;
      const sb = open.get(runId);
      if (sb) { r.endSpan(sb, undefined, err instanceof Error ? err.message : String(err)); open.delete(runId); }
    }

    handleAgentAction(action: { tool?: string; toolInput?: unknown; log?: string }): void {
      const r = rec(); if (!r) return;
      const sb = r.startSpan(String(action?.tool || "action"), SpanType.TOOL_CALL, action?.toolInput);
      r.endSpan(sb, action?.log);
    }
  }

  return new RetraceHandler();
}
