import { getConfig, requireApiKey } from "./config.js";
import { SpanBuilder, SpanType, TraceBuilder, TraceStatus } from "./trace.js";
import { createTransport } from "./transport.js";
import { installGeminiInterceptor } from "./interceptors/gemini.js";
import { installOpenAIInterceptor } from "./interceptors/openai.js";
import { installAnthropicInterceptor } from "./interceptors/anthropic.js";
export class TraceRecorder {
    builder;
    transport;
    interceptorsInstalled = false;
    output = undefined;
    constructor(opts) {
        requireApiKey();
        this.builder = new TraceBuilder();
        this.transport = createTransport();
        const cfg = getConfig();
        if (cfg.projectId)
            this.builder.setProjectId(cfg.projectId);
        if (opts?.metadata)
            this.builder.setMetadata(opts.metadata);
        if (opts?.name || opts?.input) {
            this.builder.start(opts.name, opts.input);
        }
    }
    get traceId() { return this.builder.id; }
    start(name, input) {
        this.builder.start(name, input);
        this.installInterceptors();
        this.transport.send("trace_started", this.builder.toDict());
        return this;
    }
    end(output, status = TraceStatus.COMPLETED) {
        if (output !== undefined)
            this.output = output;
        const data = this.builder.end(this.output, status);
        this.transport.send("trace_ended", {
            id: data.id,
            ended_at: data.ended_at,
            output: data.output,
            status: data.status,
            total_tokens: data.total_tokens,
            total_cost: data.total_cost,
        });
        this.transport.close();
    }
    addSpan(span) {
        span.trace_id = this.builder.id;
        this.builder.addSpan(span);
        this.transport.send("span_started", span);
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
    startSpan(name, spanType = SpanType.LLM_CALL, input, model, parentId) {
        const sb = new SpanBuilder(name, spanType).start();
        sb.setTraceId(this.builder.id);
        if (input !== undefined)
            sb.setInput(input);
        if (model)
            sb.setModel(model);
        if (parentId)
            sb.setParentId(parentId);
        this.transport.send("span_started", sb.toData());
        return sb;
    }
    endSpan(spanBuilder, output, error) {
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
    installInterceptors() {
        if (this.interceptorsInstalled)
            return;
        installGeminiInterceptor((span) => this.addSpan(span));
        installOpenAIInterceptor((span) => this.addSpan(span));
        installAnthropicInterceptor((span) => this.addSpan(span));
        this.interceptorsInstalled = true;
    }
}
export function record(opts) {
    const cfg = getConfig();
    if (!cfg.enabled) {
        // Return a no-op recorder
        return new TraceRecorder(opts);
    }
    return new TraceRecorder(opts);
}
export function trace(fn, opts) {
    const cfg = getConfig();
    return (...args) => {
        if (!cfg.enabled)
            return fn(...args);
        const recorder = new TraceRecorder({
            name: opts?.name || fn.name || "anonymous",
            input: opts?.input ?? args,
            metadata: opts?.metadata,
        });
        recorder.start(opts?.name || fn.name || "anonymous", opts?.input ?? args);
        try {
            const result = fn(...args);
            // Handle async functions
            if (result && typeof result.then === "function") {
                return result.then((resolved) => { recorder.end(resolved, TraceStatus.COMPLETED); return resolved; }, (err) => { recorder.end(undefined, TraceStatus.FAILED); throw err; });
            }
            recorder.end(result, TraceStatus.COMPLETED);
            return result;
        }
        catch (err) {
            recorder.end(undefined, TraceStatus.FAILED);
            throw err;
        }
    };
}
