/**
 * Context-isolated routing for auto-instrumented spans (mirrors the Python `_dispatch.py`
 * ContextVar dispatcher).
 *
 * The interceptors (openai/anthropic/gemini) are patched globally and invoke ONE stable
 * dispatcher. The target recorder for the current async context lives in an AsyncLocalStorage
 * store, so concurrent traces on a server each resolve their own recorder — instead of a
 * module-global, last-writer-wins callback that cross-routed intercepted spans to whichever
 * trace was created most recently.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { SpanData } from "../trace.js";

export type SpanCallback = (span: SpanData) => void;
/** A recorder-side sink for the two-phase streaming-span lifecycle (open at invocation, finalize
 *  once at clean-drain / break / error / trace-end / exit). Routed like SpanCallback. */
export interface OpenSpanSink {
  registerOpenSpan(spanId: string, finalize: (reason: "complete" | "partial") => void): void;
  unregisterOpenSpan(spanId: string): void;
}

const activeRecorder = new AsyncLocalStorage<SpanCallback>();
const activeOpenSink = new AsyncLocalStorage<OpenSpanSink>();

// Fallback for the imperative record()/start()/end() API used outside a runWithActiveRecorder
// scope. Last-writer-wins (documented limitation for purely imperative concurrent traces).
let fallbackCb: SpanCallback | null = null;
let fallbackSink: OpenSpanSink | null = null;

/** Stable interceptor callback — routes an intercepted span to the recorder active in this context. */
export function dispatchInterceptedSpan(span: SpanData): void {
  const cb = activeRecorder.getStore() ?? fallbackCb;
  cb?.(span);
}

/** Capture the span sink active in THIS context (synchronously, at invocation) so a deferred
 *  finalizer can emit to the right recorder even when later called from a context where the ALS
 *  store is absent (the AFC layer's .return(), trace-end, exit-flush). */
export function captureActiveSpanEmit(): SpanCallback | null {
  return activeRecorder.getStore() ?? fallbackCb;
}

/** Register an open streaming span's finalizer with the active recorder (two-phase, model (b)). */
export function dispatchRegisterOpenSpan(spanId: string, finalize: (reason: "complete" | "partial") => void): void {
  const sink = activeOpenSink.getStore() ?? fallbackSink;
  sink?.registerOpenSpan(spanId, finalize);
}

/** Drop an open span's finalizer once it has been finalized in-band. */
export function dispatchUnregisterOpenSpan(spanId: string): void {
  const sink = activeOpenSink.getStore() ?? fallbackSink;
  sink?.unregisterOpenSpan(spanId);
}

/** Run `fn` with `cb` as the active intercepted-span handler for its async context (fully isolated). */
export function runWithActiveRecorder<T>(cb: SpanCallback, fn: () => T, sink?: OpenSpanSink): T {
  if (sink) return activeRecorder.run(cb, () => activeOpenSink.run(sink, fn));
  return activeRecorder.run(cb, fn);
}

/** Set the imperative-API fallback handler. Returns the PREVIOUS handler so callers can restore
 * it (e.g. a nested trace() must not wipe the ambient init() fallback). Pass null to clear. */
export function setActiveRecorderFallback(cb: SpanCallback | null, sink?: OpenSpanSink | null): SpanCallback | null {
  const prev = fallbackCb;
  fallbackCb = cb;
  if (sink !== undefined) fallbackSink = sink;
  return prev;
}

/** The current imperative-API open-span sink (so a nested trace can save/restore it). */
export function currentFallbackSink(): OpenSpanSink | null {
  return fallbackSink;
}
