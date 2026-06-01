import { getConfig, requireApiKey } from "./config.js";
import { SpanBuilder, SpanData, SpanType, TraceBuilder, TraceStatus } from "./trace.js";
import { createTransport, Transport } from "./transport.js";
import { shouldSample } from "./utils.js";
import { installGeminiInterceptor } from "./interceptors/gemini.js";
import { installOpenAIInterceptor } from "./interceptors/openai.js";
import { installAnthropicInterceptor } from "./interceptors/anthropic.js";

// Shared transport — stays open across multiple traces for resume/replay listening
let sharedTransport: Transport | null = null;
function getSharedTransport(): Transport {
  if (!sharedTransport) {
    sharedTransport = createTransport();
    // Flush pending data before process exits
    if (typeof process !== "undefined") {
      process.on("beforeExit", () => { sharedTransport?.close(); });
    }
  }
  return sharedTransport;
}

export interface RecordOptions {
  name?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  /** When set, spans emitted before this span ID is encountered are suppressed (pre-fork filtering). */
  forkPointSpanId?: string;
}

export class TraceRecorder {
  private builder: TraceBuilder;
  private transport: Transport;
  private interceptorsInstalled = false;
  private forkPointSpanId: string | undefined;
  private forkPointReached = false;
  private spanCounter = 0;
  output: unknown = undefined;

  constructor(opts?: RecordOptions) {
    requireApiKey();
    this.builder = new TraceBuilder();
    this.transport = getSharedTransport();
    this.forkPointSpanId = opts?.forkPointSpanId;
    // If no fork point specified, all spans pass through
    this.forkPointReached = !opts?.forkPointSpanId;
    const cfg = getConfig();
    if (cfg.projectId) this.builder.setProjectId(cfg.projectId);
    if (opts?.metadata) this.builder.setMetadata(opts.metadata);
    if (opts?.sessionId) this.builder.setSessionId(opts.sessionId);
    if (opts?.name || opts?.input) {
      this.builder.start(opts.name, opts.input);
    }
  }

  get traceId() { return this.builder.id; }

  start(name?: string, input?: unknown): this {
    this.builder.start(name, input);
    this.installInterceptors();
    this.transport.send("trace_started", this.builder.toDict() as unknown as Record<string, unknown>);
    return this;
  }

  end(output?: unknown, status: TraceStatus = TraceStatus.COMPLETED) {
    if (output !== undefined) this.output = output;
    const data = this.builder.end(this.output, status);
    this.transport.send("trace_ended", {
      id: data.id,
      ended_at: data.ended_at!,
      output: data.output,
      status: data.status,
      total_tokens: data.total_tokens,
      total_cost: data.total_cost,
    });
    // Shared transport stays open for resume/replay listening
  }

  addSpan(span: SpanData) {
    this.spanCounter++;
    // Fork point filtering: skip spans until the fork point is reached.
    // The server copies pre-fork spans; the SDK only emits from fork point onward.
    if (!this.forkPointReached) {
      if (this.forkPointSpanId && this.spanCounter >= 1) {
        // Use span counter as proxy — the Nth span corresponds to the fork point index.
        // Mark as reached so all subsequent spans pass through.
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
    installGeminiInterceptor((span) => this.addSpan(span));
    installOpenAIInterceptor((span) => this.addSpan(span));
    installAnthropicInterceptor((span) => this.addSpan(span));
    this.interceptorsInstalled = true;
  }
}

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
    recorder.start(opts?.name || fn.name || "anonymous", opts?.input ?? args);

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
  };
}
