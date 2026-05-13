export declare enum SpanType {
    LLM_CALL = "llm_call",
    TOOL_CALL = "tool_call",
    TOOL_RESULT = "tool_result",
    REASONING = "reasoning",
    ACTION = "action",
    ERROR = "error",
    FORK_POINT = "fork_point"
}
export declare enum TraceStatus {
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed"
}
export interface SpanData {
    id: string;
    trace_id: string;
    parent_id: string | null;
    span_type: string;
    name: string;
    model?: string;
    input?: unknown;
    output?: unknown;
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
    duration_ms?: number;
    metadata?: Record<string, unknown>;
    started_at: string;
    ended_at?: string;
    error?: string;
}
export interface TraceData {
    id: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    status: string;
    total_tokens: number;
    total_cost: number;
    total_duration_ms: number;
    metadata?: Record<string, unknown>;
    started_at: string;
    ended_at?: string;
    spans?: SpanData[];
    project_id?: string;
}
export declare class SpanBuilder {
    private data;
    private _startTime?;
    constructor(name: string, spanType: SpanType);
    setModel(model: string): this;
    setInput(input: unknown): this;
    setOutput(output: unknown): this;
    setParentId(id: string): this;
    setTraceId(id: string): this;
    setMetadata(m: Record<string, unknown>): this;
    start(): this;
    end(output?: unknown, error?: string): SpanData;
    get id(): string;
    toData(): SpanData;
}
export declare class TraceBuilder {
    private data;
    private _startTime?;
    constructor();
    start(name?: string, input?: unknown): this;
    end(output?: unknown, status?: TraceStatus): TraceData;
    addSpan(span: SpanData): void;
    get id(): string;
    setProjectId(id: string): void;
    setMetadata(m: Record<string, unknown>): void;
    toDict(): TraceData;
}
