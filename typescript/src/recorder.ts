import { getConfig, requireApiKey } from "./config.js";
import { SpanBuilder, SpanData, SpanType, TraceBuilder, TraceStatus } from "./trace.js";
import { createTransport, Transport } from "./transport.js";
import { installGeminiInterceptor } from "./interceptors/gemini.js";
import { installOpenAIInterceptor } from "./interceptors/openai.js";
import { installAnthropicInterceptor } from "./interceptors/anthropic.js";

export interface RecordOptions {
  name?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export class TraceRecorder {
  private builder: TraceBuilder;
  private transport: Transport;
  private interceptorsInstalled = false;
  output: unknown = undefined;

  constructor(opts?: RecordOptions) {
    requireApiKey();
    this.builder = new TraceBuilder();
    this.transport = createTransport();
    const cfg = getConfig();
    if (cfg.projectId) this.builder.setProjectId(cfg.projectId);
    if (opts?.metadata) this.builder.setMetadata(opts.metadata);
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
    this.transport.close();
  }

  addSpan(span: SpanData) {
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
  if (!cfg.enabled || Math.random() > cfg.sampleRate) {
    // Return a no-op proxy that doesn't require API key or connect
    const noop = {} as TraceRecorder;
    return new Proxy(noop, { get: (_t, prop) => typeof prop === "string" ? (() => noop) : undefined }) as TraceRecorder;
  }
  return new TraceRecorder(opts);
}

export function trace<T>(fn: (...args: unknown[]) => T, opts?: RecordOptions): (...args: unknown[]) => T {
  const cfg = getConfig();
  return (...args: unknown[]): T => {
    if (!cfg.enabled || Math.random() > cfg.sampleRate) return fn(...args);

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
