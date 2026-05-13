import { genId, nowIso, utcNow } from "./utils.js";
export var SpanType;
(function (SpanType) {
    SpanType["LLM_CALL"] = "llm_call";
    SpanType["TOOL_CALL"] = "tool_call";
    SpanType["TOOL_RESULT"] = "tool_result";
    SpanType["REASONING"] = "reasoning";
    SpanType["ACTION"] = "action";
    SpanType["ERROR"] = "error";
    SpanType["FORK_POINT"] = "fork_point";
})(SpanType || (SpanType = {}));
export var TraceStatus;
(function (TraceStatus) {
    TraceStatus["RUNNING"] = "running";
    TraceStatus["COMPLETED"] = "completed";
    TraceStatus["FAILED"] = "failed";
})(TraceStatus || (TraceStatus = {}));
export class SpanBuilder {
    data;
    _startTime;
    constructor(name, spanType) {
        this.data = { id: genId(), span_type: spanType, name, trace_id: "", parent_id: null, started_at: nowIso() };
    }
    setModel(model) { this.data.model = model; return this; }
    setInput(input) { this.data.input = input; return this; }
    setOutput(output) { this.data.output = output; return this; }
    setParentId(id) { this.data.parent_id = id; return this; }
    setTraceId(id) { this.data.trace_id = id; return this; }
    setMetadata(m) { this.data.metadata = m; return this; }
    start() {
        this._startTime = utcNow();
        this.data.started_at = this._startTime.toISOString();
        return this;
    }
    end(output, error) {
        const now = utcNow();
        this.data.ended_at = now.toISOString();
        if (output !== undefined)
            this.data.output = output;
        if (error)
            this.data.error = error;
        if (this._startTime) {
            this.data.duration_ms = now.getTime() - this._startTime.getTime();
        }
        return this.data;
    }
    get id() { return this.data.id; }
    toData() { return this.data; }
}
export class TraceBuilder {
    data;
    _startTime;
    constructor() {
        this.data = {
            id: genId(),
            status: TraceStatus.RUNNING,
            total_tokens: 0,
            total_cost: 0,
            total_duration_ms: 0,
            started_at: nowIso(),
            spans: [],
        };
    }
    start(name, input) {
        this._startTime = utcNow();
        this.data.started_at = this._startTime.toISOString();
        if (name)
            this.data.name = name;
        if (input !== undefined)
            this.data.input = input;
        return this;
    }
    end(output, status = TraceStatus.COMPLETED) {
        const now = utcNow();
        this.data.ended_at = now.toISOString();
        this.data.status = status;
        if (output !== undefined)
            this.data.output = output;
        if (this._startTime) {
            this.data.total_duration_ms = now.getTime() - this._startTime.getTime();
        }
        return this.data;
    }
    addSpan(span) {
        this.data.spans.push(span);
        this.data.total_tokens += (span.input_tokens || 0) + (span.output_tokens || 0);
        this.data.total_cost += span.cost || 0;
    }
    get id() { return this.data.id; }
    setProjectId(id) { this.data.project_id = id; }
    setMetadata(m) { this.data.metadata = m; }
    toDict() { return this.data; }
}
