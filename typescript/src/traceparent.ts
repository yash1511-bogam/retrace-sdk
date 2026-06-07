/**
 * W3C Trace Context (traceparent) propagation.
 * Format: 00-{trace_id_32hex}-{parent_id_16hex}-{flags_2hex}
 *
 * This enables distributed tracing across service boundaries.
 * When a traced function makes HTTP calls, the traceparent header
 * is injected so downstream services can correlate their spans.
 */

import { AsyncLocalStorage } from "async_hooks";

// Per-async-context trace context. Concurrent traces each get their own store, so one
// trace's context can't leak into another's outbound requests. The module-level globals
// below remain as a fallback for the legacy imperative setTraceContext/clearTraceContext API.
const traceContextStore = new AsyncLocalStorage<{ traceId: string; spanId: string }>();

let _currentTraceId: string | null = null;
let _currentSpanId: string | null = null;

/**
 * Run `fn` with an isolated trace context. Outgoing-request helpers (getTraceparent /
 * injectTraceparent) called within `fn` (including across awaits) see this context, with
 * no cross-contamination between concurrent traces.
 */
export function withTraceContext<T>(traceId: string, spanId: string, fn: () => T): T {
  return traceContextStore.run(
    { traceId: traceId.replace(/-/g, ""), spanId: spanId.replace(/-/g, "").slice(0, 16) },
    fn,
  );
}

/** Set the active trace context for outgoing requests (legacy imperative API). */
export function setTraceContext(traceId: string, spanId: string): void {
  // Convert UUID format to 32-hex (remove dashes)
  _currentTraceId = traceId.replace(/-/g, "");
  // Take first 16 chars of span ID as parent span
  _currentSpanId = spanId.replace(/-/g, "").slice(0, 16);
}

/**
 * Imperative ALS context for the recorder's start()/end(), which have no callback scope to wrap.
 * Uses AsyncLocalStorage.enterWith so the context is isolated PER ASYNC EXECUTION — two concurrent
 * imperative traces (each in its own async context) get their own store instead of clobbering a
 * shared module global. This is the fix for the old setTraceContext()-writes-a-global contamination:
 * the recorder no longer touches _currentTraceId at all; the globals remain ONLY for the explicitly
 * legacy, single-context setTraceContext() public API.
 */
export function enterTraceContext(traceId: string, spanId: string): void {
  traceContextStore.enterWith({ traceId: traceId.replace(/-/g, ""), spanId: spanId.replace(/-/g, "").slice(0, 16) });
}

/** Clear the imperative ALS context for the current execution (empty store → getTraceparent returns
 *  null WITHOUT falling through to the legacy globals). */
export function exitTraceContext(): void {
  traceContextStore.enterWith({ traceId: "", spanId: "" });
}

/** Clear the active trace context. */
export function clearTraceContext(): void {
  _currentTraceId = null;
  _currentSpanId = null;
}

/** Get the current traceparent header value, or null if no active trace. */
export function getTraceparent(): string | null {
  const scoped = traceContextStore.getStore();
  const traceId = scoped?.traceId ?? _currentTraceId;
  const spanId = scoped?.spanId ?? _currentSpanId;
  if (!traceId || !spanId) return null;
  // version-trace_id-parent_id-flags (01 = sampled)
  return `00-${traceId}-${spanId}-01`;
}

/**
 * Inject traceparent into a headers object (for fetch/axios/http calls).
 * Returns the headers with traceparent added if a trace is active.
 */
export function injectTraceparent(headers: Record<string, string> = {}): Record<string, string> {
  const tp = getTraceparent();
  if (tp) {
    headers["traceparent"] = tp;
  }
  return headers;
}

/**
 * Parse an incoming traceparent header.
 * Returns { traceId, parentId, sampled } or null if invalid.
 */
export function parseTraceparent(header: string): { traceId: string; parentId: string; sampled: boolean } | null {
  const parts = header.split("-");
  if (parts.length !== 4 || parts[0] !== "00") return null;
  if (parts[1].length !== 32 || parts[2].length !== 16) return null;
  return {
    traceId: parts[1],
    parentId: parts[2],
    sampled: parts[3] === "01",
  };
}
