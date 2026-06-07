import { getConfig, requireApiKey } from "./config.js";
import { SpanBuilder, SpanData, SpanType, TraceBuilder, TraceStatus } from "./trace.js";
import { createTransport, registerProcessExitFlush, Transport } from "./transport.js";
import { shouldSample } from "./utils.js";
import { installGeminiInterceptor } from "./interceptors/gemini.js";
import { installOpenAIInterceptor } from "./interceptors/openai.js";
import { installAnthropicInterceptor } from "./interceptors/anthropic.js";
import { dispatchInterceptedSpan, runWithActiveRecorder, setActiveRecorderFallback, currentFallbackSink, OpenSpanSink } from "./interceptors/_dispatch.js";
import { withTraceContext, enterTraceContext, exitTraceContext } from "./traceparent.js";

// Shared transport — stays open across multiple traces for resume/replay listening
let sharedTransport: Transport | null = null;
// Count of imperative (non-HOF) recorders currently between start() and end(). The bare imperative
// record()/TraceRecorder path is NOT context-isolated (see record() doc + traceparent.ts), so two
// overlapping imperative traces can cross-attribute spans/traceparent. We can't make it isolated
// without an async scope, but we MUST NOT let the corruption be silent — overlap is loudly warned,
// pointing at trace() (the concurrency-safe API). HOF-managed starts pass {managed:true} and are
// excluded (they ARE isolated via withTraceContext/runWithActiveRecorder).
let activeImperativeRecorders = 0;
function getSharedTransport(): Transport {
  if (!sharedTransport) {
    sharedTransport = createTransport(getConfig().transport);
    // Hand the transport the user's callback (or undefined). The transport owns the policy:
    // callback-safety (a throwing onError can't kill the WS loop) and the throttled default-warn
    // when no callback is registered — see WSTransport.surfaceSignal. Set onError in configure()
    // before the first trace.
    sharedTransport.onError = getConfig().onError;
    // Flush pending data before the process exits. Covers beforeExit (graceful) + SIGTERM/SIGINT
    // (with signal-ownership semantics), using an HTTP one-shot for buffered events since a WS
    // handshake can't reliably complete during teardown. See registerProcessExitFlush.
    // Only register the network exit hook when actually configured — an imported-but-unconfigured
    // SDK installs no signal handlers and makes no outbound call on exit.
    const cfg = getConfig();
    if (typeof process !== "undefined" && cfg.enabled && cfg.apiKey) {
      registerProcessExitFlush(sharedTransport);
    }
  }
  return sharedTransport;
}

/** Drain the shared transport's in-flight data to the network (awaited on graceful shutdown). */
export async function flushSharedTransport(): Promise<void> {
  await sharedTransport?.flush();
}

/** Exit-path drain — uses the transport's HTTP one-shot for buffered events when available. */
export async function drainSharedTransportOnExit(budgetMs?: number): Promise<void> {
  if (sharedTransport?.flushOnExit) await sharedTransport.flushOnExit(budgetMs);
  else await sharedTransport?.flush();
}

export interface RecordOptions {
  name?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  /** When set, spans emitted before this span ID is encountered are suppressed (pre-fork filtering). */
  forkPointSpanId?: string;
  /** 0-based ordinal of the fork-point span among the original ordered spans. Suppression is
   *  positional: spans with counter <= index are suppressed, emission starts at index+1. */
  forkPointIndex?: number;
}

export class TraceRecorder {
  private builder: TraceBuilder;
  private transport: Transport;
  private interceptorsInstalled = false;
  private countedImperative = false;
  private prevFallback: ((span: SpanData) => void) | null = null;
  private prevFallbackSink: OpenSpanSink | null = null;
  private forkPointSpanId: string | undefined;
  private forkPointIndex: number | undefined;
  private forkPointReached = false;
  private spanCounter = 0;
  output: unknown = undefined;

  constructor(opts?: RecordOptions) {
    requireApiKey();
    this.builder = new TraceBuilder();
    this.transport = getSharedTransport();
    this.forkPointSpanId = opts?.forkPointSpanId;
    this.forkPointIndex = opts?.forkPointIndex;
    // Suppress pre-fork spans only when BOTH a fork point and its positional index are known;
    // otherwise (normal recording, or a fork command without an index) emit everything.
    this.forkPointReached = !opts?.forkPointSpanId || opts?.forkPointIndex === undefined;
    const cfg = getConfig();
    if (cfg.projectId) this.builder.setProjectId(cfg.projectId);
    if (opts?.metadata) this.builder.setMetadata(opts.metadata);
    if (opts?.sessionId) this.builder.setSessionId(opts.sessionId);
    if (opts?.name || opts?.input) {
      this.builder.start(opts.name, opts.input);
    }
  }

  get traceId() { return this.builder.id; }

  start(name?: string, input?: unknown, opts?: { managed?: boolean }): this {
    // Never-silent guard for the imperative path: if another imperative trace is already active when
    // this one starts, overlapping imperative record() use can cross-attribute spans/traceparent.
    // Warn loudly and point at trace() — convert silent corruption into a loud signal. HOF-managed
    // starts are isolated (withTraceContext) and excluded.
    if (!opts?.managed) {
      if (activeImperativeRecorders > 0) {
        console.warn(
          "[retrace] CONCURRENT imperative record() detected: another imperative trace is still active. " +
          "The bare record()/TraceRecorder path is NOT concurrency-isolated — spans and traceparent from " +
          "overlapping imperative traces can be cross-attributed. Use trace() (the concurrency-safe API) " +
          "for concurrent/parallel workloads.",
        );
      }
      activeImperativeRecorders++;
      this.countedImperative = true;
    }
    this.builder.start(name, input);
    this.installInterceptors();
    // Imperative API: route intercepted spans to this recorder and propagate trace context for
    // outbound requests. Save the prior fallback so end() can RESTORE it (a nested trace() must not
    // wipe the ambient init() fallback). The trace()/HOF path additionally isolates via ALS.
    this.prevFallbackSink = currentFallbackSink();
    this.prevFallback = setActiveRecorderFallback((span) => this.addSpan(span), this);
    // ALS-isolated traceparent (per async execution), NOT a module global — so concurrent imperative
    // traces never leak context into one another's outbound requests. The trace()/HOF path also
    // wraps in withTraceContext; this covers the bare start()/end() imperative path.
    enterTraceContext(this.builder.id, this.builder.id);
    this.transport.send("trace_started", this.builder.toDict() as unknown as Record<string, unknown>);
    return this;
  }

  // ── OpenSpanSink: two-phase streaming spans (open at invocation, finalize once) ──
  private openSpans = new Map<string, (reason: "complete" | "partial") => void>();

  registerOpenSpan(spanId: string, finalize: (reason: "complete" | "partial") => void): void {
    this.openSpans.set(spanId, finalize);
  }

  unregisterOpenSpan(spanId: string): void {
    this.openSpans.delete(spanId);
  }

  /** Finalize any still-open streaming spans as partial (capture_complete:false). Called on end()
   *  so a stream the AFC layer abandoned mid-drain is still emitted into the trace, flagged
   *  not-byte-replayable, rather than lost or appearing only at process exit. */
  private finalizeOpenSpans(): void {
    if (this.openSpans.size === 0) return;
    for (const [, finalize] of this.openSpans) {
      try { finalize("partial"); } catch { /* best effort */ }
    }
    this.openSpans.clear();
  }

  end(output?: unknown, status: TraceStatus = TraceStatus.COMPLETED, opts?: { terminatedEarly?: boolean }) {
    if (this.countedImperative) {
      activeImperativeRecorders = Math.max(0, activeImperativeRecorders - 1);
      this.countedImperative = false;
    }
    if (output !== undefined) this.output = output;
    // Close any dangling streaming spans (capture_complete:false) BEFORE the terminal event, so
    // they land in this trace.
    this.finalizeOpenSpans();
    const data = this.builder.end(this.output, status);
    this.transport.send("trace_ended", {
      id: data.id,
      ended_at: data.ended_at!,
      output: data.output,
      status: data.status,
      total_tokens: data.total_tokens,
      total_cost: data.total_cost,
      // Force-closed by exit-flush/signal: a synthesized terminal must NOT look clean to the
      // replay-guard. terminated_early ⇒ refuse byte-deterministic replay (same as no-terminal /
      // lossy / capture_complete:false). Only a naturally-drained run produces a clean terminal.
      ...(opts?.terminatedEarly ? { terminated_early: true } : {}),
    });
    // Restore the enclosing trace's fallback (e.g. the ambient init() recorder) instead of nulling.
    setActiveRecorderFallback(this.prevFallback, this.prevFallbackSink);
    this.prevFallback = null;
    this.prevFallbackSink = null;
    exitTraceContext();
    // Shared transport stays open for resume/replay listening
  }

  addSpan(span: SpanData) {
    this.spanCounter++;
    // Fork-point filtering: during cascade replay suppress the pre-fork spans (the server already
    // has them / they replay from the cassette) and emit only from the fork point onward. The fork
    // point is the (forkPointIndex)-th span (0-based), i.e. the (index+1)-th counted here, so
    // suppress while spanCounter <= index and emit once spanCounter > index. (Previously this
    // compared spanCounter >= 1, which is always true after the increment ⇒ zero suppression.)
    if (!this.forkPointReached) {
      if (this.forkPointIndex !== undefined && this.spanCounter > this.forkPointIndex) {
        this.forkPointReached = true;
      } else {
        return; // Suppress pre-fork span
      }
    }
    span.trace_id = this.builder.id;
    this.builder.addSpan(span);
    this.transport.send("span_started", span as unknown as Record<string, unknown>);
    if (span.ended_at) {
      this.transport.send("span_ended", {
        id: span.id,
        ended_at: span.ended_at,
        output: span.output,
        output_tokens: span.output_tokens,
        cost: span.cost,
        error: span.error,
      });
    }
  }

  startSpan(name: string, spanType: SpanType = SpanType.LLM_CALL, input?: unknown, model?: string, parentId?: string): SpanBuilder {
    const sb = new SpanBuilder(name, spanType).start();
    sb.setTraceId(this.builder.id);
    if (input !== undefined) sb.setInput(input);
    if (model) sb.setModel(model);
    if (parentId) sb.setParentId(parentId);
    this.transport.send("span_started", sb.toData() as unknown as Record<string, unknown>);
    return sb;
  }

  endSpan(spanBuilder: SpanBuilder, output?: unknown, error?: string) {
    const span = spanBuilder.end(output, error);
    span.trace_id = this.builder.id;
    this.builder.addSpan(span);
    this.transport.send("span_ended", {
      id: span.id,
      ended_at: span.ended_at,
      output: span.output,
      output_tokens: span.output_tokens,
      cost: span.cost,
      error: span.error,
    });
  }

  private installInterceptors() {
    if (this.interceptorsInstalled) return;
    // Install ONE stable dispatcher; the active recorder is resolved per async-context (see
    // interceptors/_dispatch.ts) so concurrent traces don't cross-route intercepted spans.
    installGeminiInterceptor(dispatchInterceptedSpan);
    installOpenAIInterceptor(dispatchInterceptedSpan);
    installAnthropicInterceptor(dispatchInterceptedSpan);
    this.interceptorsInstalled = true;
  }
}

/**
 * Create a manual (imperative) recorder you drive with start()/end().
 *
 * CONCURRENCY: this bare imperative path is NOT context-isolated — start()/end() have no async
 * scope to bind, so span-routing and traceparent are tracked via process/async-context state that
 * concurrent imperative traces (e.g. several started under one Promise.all) can stomp. For
 * concurrent workloads use `trace()`, which wraps your function in AsyncLocalStorage (provably
 * isolated). Sequential start→end cycles are correct, and overlapping imperative use is detected
 * and LOUDLY WARNED (never silent corruption) — pointing you at `trace()`. (Python's `@record`
 * decorator wraps the function and IS isolated on both asyncio and threads; the TS equivalent is
 * `trace()`.)
 */
export function record(opts?: RecordOptions): TraceRecorder {
  const cfg = getConfig();
  if (!cfg.enabled || !shouldSample(cfg.sampleRate, cfg.sampleSeed, opts?.name)) {
    // Return a properly-typed no-op recorder that satisfies the TraceRecorder interface
    const noop: TraceRecorder = Object.create(TraceRecorder.prototype);
    Object.defineProperties(noop, {
      traceId: { get: () => "" },
      output: { value: undefined, writable: true },
    });
    noop.start = () => noop;
    noop.end = () => {};
    noop.addSpan = () => {};
    noop.startSpan = (name: string) => new SpanBuilder(name, "llm_call" as SpanType);
    noop.endSpan = () => {};
    return noop;
  }
  return new TraceRecorder(opts);
}

export function trace<T>(fn: (...args: unknown[]) => T, opts?: RecordOptions & { resumable?: boolean }): (...args: unknown[]) => T {
  const cfg = getConfig();
  // Register for cascade replay if resumable
  if (opts?.resumable) {
    import("./resume.js").then(({ registerResumable }) => {
      registerResumable(opts?.name || fn.name || "anonymous", fn as (...args: unknown[]) => unknown);
    });
  }
  return (...args: unknown[]): T => {
    if (!cfg.enabled || !shouldSample(cfg.sampleRate, cfg.sampleSeed, opts?.name || fn.name)) return fn(...args);

    const recorder = new TraceRecorder({
      name: opts?.name || fn.name || "anonymous",
      input: opts?.input ?? args,
      metadata: opts?.metadata,
    });
    // Isolate this trace's intercepted-span routing AND traceparent context to its own async
    // context, so concurrent traces on a server never cross-route spans or leak context.
    const tid = recorder.traceId;
    const route = (span: SpanData) => recorder.addSpan(span);
    return runWithActiveRecorder(route, () => withTraceContext(tid, tid, () => {
      recorder.start(opts?.name || fn.name || "anonymous", opts?.input ?? args, { managed: true });
      try {
        const result = fn(...args);
        // Handle async functions
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as unknown as Promise<unknown>).then(
            (resolved) => { recorder.end(resolved, TraceStatus.COMPLETED); return resolved; },
            (err) => { recorder.end(undefined, TraceStatus.FAILED); throw err; }
          ) as unknown as T;
        }
        recorder.end(result, TraceStatus.COMPLETED);
        return result;
      } catch (err) {
        recorder.end(undefined, TraceStatus.FAILED);
        throw err;
      }
    }), recorder);
  };
}
