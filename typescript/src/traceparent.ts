/**
 * W3C Trace Context (traceparent) propagation.
 * Format: 00-{trace_id_32hex}-{parent_id_16hex}-{flags_2hex}
 *
 * This enables distributed tracing across service boundaries.
 * When a traced function makes HTTP calls, the traceparent header
 * is injected so downstream services can correlate their spans.
 */

let _currentTraceId: string | null = null;
let _currentSpanId: string | null = null;

/** Set the active trace context for outgoing requests. */
export function setTraceContext(traceId: string, spanId: string): void {
  // Convert UUID format to 32-hex (remove dashes)
  _currentTraceId = traceId.replace(/-/g, "");
  // Take first 16 chars of span ID as parent span
  _currentSpanId = spanId.replace(/-/g, "").slice(0, 16);
}

/** Clear the active trace context. */
export function clearTraceContext(): void {
  _currentTraceId = null;
  _currentSpanId = null;
}

/** Get the current traceparent header value, or null if no active trace. */
export function getTraceparent(): string | null {
  if (!_currentTraceId || !_currentSpanId) return null;
  // version-trace_id-parent_id-flags (01 = sampled)
  return `00-${_currentTraceId}-${_currentSpanId}-01`;
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
