import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";
import { dispatchRegisterOpenSpan, dispatchUnregisterOpenSpan, captureActiveSpanEmit } from "./_dispatch.js";
import { emitGeminiToolCalls, emitGeminiToolResults, resetToolResultDedup, extractToolSchemas, extractSamplingParams } from "./tool-spans.js";

const PRICING: Record<string, [number, number]> = {
  "gemini-3.1-flash-lite": [0.10, 0.40],
  "gemini-3.1-flash": [0.50, 3.0],
  "gemini-3-flash": [0.50, 3.0],
  "gemini-3-pro": [2.0, 12.0],
  "gemini-3.1-pro-preview": [2.0, 12.0],
  "gemini-2.5-pro": [1.25, 10.0],
  "gemini-2.5-flash": [0.30, 2.50],
  "gemini-2.5-flash-lite": [0.10, 0.40],
  "gemini-2.0-flash": [0.10, 0.40],
  "gemini-2.0-flash-lite": [0.05, 0.20],
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] || [0, 0];
  return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
}

let onSpanCallback: ((span: SpanData) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let patchedProto: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origGenerate: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origStream: any = null;
let installPromise: Promise<void> | null = null;

// Wrap a single `generateContent` implementation (the per-instance bound method). Returns a
// function with identical signature that records a span around the original call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapGenerate(original: (...a: unknown[]) => unknown): (...a: unknown[]) => any {
  return async function (this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (args[0] as Record<string, any>) || {};
    const model = (opts.model as string) || "unknown";
    const contents = opts.contents;
    const toolSchemas = extractToolSchemas("gemini", opts.config?.tools);
    const sampling = extractSamplingParams("gemini", opts);
    const spanMeta = { ...(toolSchemas ? { tool_schemas: toolSchemas } : {}), ...(sampling ? { sampling } : {}) };
    const spanId = genId();
    const startedAt = nowIso();
    const startMs = Date.now();

    const { isReplaying, consumeCassetteEntry } = await import("../replay.js");
    if (isReplaying()) {
      const entry = consumeCassetteEntry("retrace.ai.generate", "llm_call");
      if (entry) {
        return { text: entry.output_raw ?? ((entry.output as string) || ""), usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 }, candidates: [] };
      }
    }

    try {
      const result = await original.apply(this, args);
      const durationMs = Date.now() - startMs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = result as any;
      const inputTokens = res?.usageMetadata?.promptTokenCount || 0;
      const outputTokens = res?.usageMetadata?.candidatesTokenCount || 0;
      const fnNames = res?.candidates?.[0]?.content?.parts?.filter((p: { functionCall?: unknown }) => p.functionCall).map((p: { functionCall: { name: string } }) => p.functionCall.name).join(", ");
      const outputText = res?.text ?? (fnNames ? `[function_call: ${fnNames}]` : "");

      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
        input: truncateJson(contents), output: truncateJson(outputText),
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost: calcCost(model, inputTokens, outputTokens),
        duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
        ...(Object.keys(spanMeta).length ? { metadata: spanMeta } : {}),
      };
      onSpanCallback?.(span);
      if (onSpanCallback) {
        emitGeminiToolResults(contents, onSpanCallback);
        emitGeminiToolCalls(res?.candidates, spanId, model, onSpanCallback);
      }
      return result;
    } catch (err) {
      onSpanCallback?.({
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
        input: truncateJson(contents), started_at: startedAt, ended_at: nowIso(),
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

// Wrap a single `generateContentStream` implementation. Accumulates text + usage across chunks and
// emits the span when the stream completes OR is abandoned/errors (via finally).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapStream(original: (...a: unknown[]) => unknown): (...a: unknown[]) => any {
  return async function (this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (args[0] as Record<string, any>) || {};
    const model = (opts.model as string) || "unknown";
    const contents = opts.contents;
    const toolSchemas = extractToolSchemas("gemini", opts.config?.tools);
    const sampling = extractSamplingParams("gemini", opts);
    const spanMeta = { streaming: true, ...(toolSchemas ? { tool_schemas: toolSchemas } : {}), ...(sampling ? { sampling } : {}) };
    const spanId = genId();
    const startedAt = nowIso();
    const startMs = Date.now();

    const { isReplaying, consumeCassetteEntry } = await import("../replay.js");
    if (isReplaying()) {
      const entry = consumeCassetteEntry("retrace.ai.generate", "llm_call");
      if (entry) {
        const text = entry.output_raw ?? ((entry.output as string) || "");
        async function* mockStream() { yield { text, usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }; }
        return mockStream();
      }
    }

    let iterable: AsyncIterable<unknown>;
    try {
      iterable = await original.apply(this, args) as AsyncIterable<unknown>;
    } catch (err) {
      onSpanCallback?.({
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
        input: truncateJson(contents), started_at: startedAt, ended_at: nowIso(),
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastCandidates: any;
    let streamError: string | undefined;
    let emitted = false;
    let sawFunctionCall = false;
    // Bind the emit target NOW (caller's context) so finalize routes to the right recorder even
    // when called later from the AFC's .return(), trace-end, or exit-flush.
    const boundEmit = captureActiveSpanEmit() ?? onSpanCallback;

    // Streaming-A, model (b): the span is OPENED at invocation (registered with the active
    // recorder, synchronously in the CALLER's async context — registering lazily inside the
    // generator fails because the AFC layer pulls it in a different context where the ALS sink is
    // absent) and EMITTED EXACTLY ONCE at finalization — never silent. `capture_complete` is true
    // ONLY on an observed clean full-drain; false for early-break, error, or a finalize forced by
    // trace-end/exit (the AFC layer abandons this generator on a normal full consume — which is
    // why we no longer rely on observing `done`, and dropped the read-ahead hack). A
    // capture_complete:false span is NOT byte-replayable.
    const finalize = (reason: "complete" | "partial") => {
      if (emitted) return;
      emitted = true;
      dispatchUnregisterOpenSpan(spanId);
      // capture_complete:true means fully-captured AND byte-replay-eligible — clean observed drain
      // AND no function call (function-call output isn't captured as text and the AFC path may
      // re-issue). Everything else is partial.
      const complete = reason === "complete" && !sawFunctionCall;
      const fnNames = lastCandidates?.[0]?.content?.parts
        ?.filter((p: { functionCall?: unknown }) => p.functionCall)
        .map((p: { functionCall: { name: string } }) => p.functionCall.name).join(", ");
      const outputText = chunks.length ? chunks.join("") : (fnNames ? `[function_call: ${fnNames}]` : "");
      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
        input: truncateJson(contents), output: truncateJson(outputText),
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost: calcCost(model, inputTokens, outputTokens),
        duration_ms: Date.now() - startMs, started_at: startedAt, ended_at: nowIso(),
        ...(streamError ? { error: streamError } : {}),
        metadata: { ...spanMeta, capture_complete: complete },
      };
      boundEmit?.(span);
      if (boundEmit) {
        emitGeminiToolResults(contents, boundEmit);
        emitGeminiToolCalls(lastCandidates, spanId, model, boundEmit);
      }
    };
    // Register in the caller's context so trace-end / exit-flush finalizes us partial if the
    // consumer (AFC) abandons the generator mid-drain without ever reaching `done` / `.return()`.
    dispatchRegisterOpenSpan(spanId, finalize);

    async function* wrapped() {
      try {
        for await (const chunk of iterable as AsyncIterable<any>) {  // eslint-disable-line @typescript-eslint/no-explicit-any
          if (typeof chunk?.text === "string") chunks.push(chunk.text);
          if (chunk?.candidates) lastCandidates = chunk.candidates;
          // A function-call stream is NOT byte-replay-eligible: its output isn't plain text (so
          // chunks.join misses it) and the AFC layer may re-issue. Mark it so finalize never
          // stamps capture_complete:true even on a clean drain.
          if (chunk?.candidates?.[0]?.content?.parts?.some((p: { functionCall?: unknown }) => p.functionCall)) {
            sawFunctionCall = true;
          }
          if (chunk?.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = chunk.usageMetadata.candidatesTokenCount || outputTokens;
          }
          yield chunk;
        }
        finalize("complete"); // observed clean full-drain (e.g. via retrace.stream helper)
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
        finalize("partial");
        throw err;
      } finally {
        finalize("partial"); // early-break (consumer .return()) / no clean drain observed
      }
    }
    return wrapped();
  };
}

// @google/genai binds the PUBLIC `generateContent`/`generateContentStream` as own bound instance
// properties (not on the prototype), so patching the prototype's public method is a no-op. However,
// the public methods delegate to `generateContentInternal` / `generateContentStreamInternal`, which
// ARE regular methods on `Models.prototype`. Patching those is RETROACTIVE to every instance
// regardless of construction order (mirroring the Python SDK's class-method patch) — so no
// install-before-construction requirement, no race, and no `ready()` escape hatch is needed.
export function installGeminiInterceptor(onSpan: (span: SpanData) => void): Promise<void> {
  onSpanCallback = onSpan;
  resetToolResultDedup();
  if (installPromise) return installPromise; // synchronous dedupe — prevents the double-wrap race
  installPromise = import("@google/genai").then((genaiMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = genaiMod as Record<string, any>;
    const Models = mod?.Models || mod?.default?.Models;
    const proto = Models?.prototype;
    if (!proto || typeof proto.generateContentInternal !== "function") return;
    patchedProto = proto;
    origGenerate = proto.generateContentInternal;
    proto.generateContentInternal = wrapGenerate(origGenerate);
    if (typeof proto.generateContentStreamInternal === "function") {
      origStream = proto.generateContentStreamInternal;
      proto.generateContentStreamInternal = wrapStream(origStream);
    }
  }).catch(() => { /* @google/genai not installed — skip */ });
  return installPromise;
}

export function uninstallGeminiInterceptor() {
  if (patchedProto) {
    if (origGenerate) patchedProto.generateContentInternal = origGenerate;
    if (origStream) patchedProto.generateContentStreamInternal = origStream;
  }
  installPromise = null;
  onSpanCallback = null;
  patchedProto = null;
  origGenerate = null;
  origStream = null;
}
