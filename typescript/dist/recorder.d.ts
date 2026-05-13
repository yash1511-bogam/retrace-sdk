import { SpanBuilder, SpanData, SpanType, TraceStatus } from "./trace.js";
export interface RecordOptions {
    name?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
}
export declare class TraceRecorder {
    private builder;
    private transport;
    private interceptorsInstalled;
    output: unknown;
    constructor(opts?: RecordOptions);
    get traceId(): string;
    start(name?: string, input?: unknown): this;
    end(output?: unknown, status?: TraceStatus): void;
    addSpan(span: SpanData): void;
    startSpan(name: string, spanType?: SpanType, input?: unknown, model?: string, parentId?: string): SpanBuilder;
    endSpan(spanBuilder: SpanBuilder, output?: unknown, error?: string): void;
    private installInterceptors;
}
export declare function record(opts?: RecordOptions): TraceRecorder;
export declare function trace<T>(fn: (...args: unknown[]) => T, opts?: RecordOptions): (...args: unknown[]) => T;
