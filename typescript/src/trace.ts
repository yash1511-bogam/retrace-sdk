import { genId, nowIso, utcNow } from "./utils.js";

export enum SpanType {
  LLM_CALL = "llm_call",
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  REASONING = "reasoning",
  ACTION = "action",
  ERROR = "error",
  FORK_POINT = "fork_point",
}

export enum TraceStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
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

export class SpanBuilder {
  private data: Partial<SpanData> & { id: string; span_type: string; name: string };
  private _startTime?: Date;

  constructor(name: string, spanType: SpanType) {
    this.data = { id: genId(), span_type: spanType, name, trace_id: "", parent_id: null, started_at: nowIso() };
  }

  setModel(model: string) { this.data.model = model; return this; }
  setInput(input: unknown) { this.data.input = input; return this; }
  setOutput(output: unknown) { this.data.output = output; return this; }
  setParentId(id: string) { this.data.parent_id = id; return this; }
  setTraceId(id: string) { this.data.trace_id = id; return this; }
  setMetadata(m: Record<string, unknown>) { this.data.metadata = m; return this; }

  start(): this {
    this._startTime = utcNow();
    this.data.started_at = this._startTime.toISOString();
    return this;
  }

  end(output?: unknown, error?: string): SpanData {
    const now = utcNow();
    this.data.ended_at = now.toISOString();
    if (output !== undefined) this.data.output = output;
    if (error) this.data.error = error;
    if (this._startTime) {
      this.data.duration_ms = now.getTime() - this._startTime.getTime();
    }
    return this.data as SpanData;
  }

  get id() { return this.data.id; }
  toData(): SpanData { return this.data as SpanData; }
}

export class TraceBuilder {
  private data: TraceData;
  private _startTime?: Date;

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

  start(name?: string, input?: unknown): this {
    this._startTime = utcNow();
    this.data.started_at = this._startTime.toISOString();
    if (name) this.data.name = name;
    if (input !== undefined) this.data.input = input;
    return this;
  }

  end(output?: unknown, status: TraceStatus = TraceStatus.COMPLETED): TraceData {
    const now = utcNow();
    this.data.ended_at = now.toISOString();
    this.data.status = status;
    if (output !== undefined) this.data.output = output;
    if (this._startTime) {
      this.data.total_duration_ms = now.getTime() - this._startTime.getTime();
    }
    return this.data;
  }

  addSpan(span: SpanData) {
    this.data.spans!.push(span);
    this.data.total_tokens += (span.input_tokens || 0) + (span.output_tokens || 0);
    this.data.total_cost += span.cost || 0;
  }

  get id() { return this.data.id; }
  setProjectId(id: string) { this.data.project_id = id; }
  setMetadata(m: Record<string, unknown>) { this.data.metadata = m; }
  toDict(): TraceData { return this.data; }
}
