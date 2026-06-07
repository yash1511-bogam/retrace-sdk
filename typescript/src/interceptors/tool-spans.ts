/**
 * Tool-span extraction (Phase 1C).
 *
 * Provider interceptors historically emitted only a single `llm_call` span and dropped the
 * model's tool calls entirely (the most common agent-failure class — tool errors + tool
 * loops — was therefore invisible). These helpers derive structured `tool_call` and
 * `tool_result` spans from a provider request/response so tool usage is captured with NO
 * manual instrumentation.
 *
 * - `tool_call` spans come from the model's response (the calls it REQUESTED), with arguments
 *   parsed into structured JSON (not stringified into the output text).
 * - `tool_result` spans come from the tool messages the caller feeds back on the NEXT request
 *   (the verbatim recorded result, including errors/empty). They are deduped by the provider
 *   tool-call id so they are emitted once, not on every subsequent turn.
 *
 * Detectors downstream (2C schema validation, 2D loop detection, 3C tool-output hallucination)
 * depend on these spans + the `tool_call_id` linkage carried in metadata.
 */
import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";

type Emit = (span: SpanData) => void;

// Bounded dedup of emitted tool_result spans (keyed by provider tool-call id). Cleared when a
// new trace installs its callback (see reset call in each interceptor) to bound memory.
const emittedToolResultIds = new Set<string>();

export function resetToolResultDedup(): void {
  emittedToolResultIds.clear();
}

function markEmitted(id: string): boolean {
  if (emittedToolResultIds.has(id)) return false;
  if (emittedToolResultIds.size > 5000) emittedToolResultIds.clear();
  emittedToolResultIds.add(id);
  return true;
}

/** Parse a JSON-string arguments payload into structured JSON; leave non-strings as-is. */
export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Extract declared tool parameter schemas (name → JSON schema) from a provider request's tool
 * definitions, so the detection engine can validate tool_call arguments against ground truth.
 */
export function extractToolSchemas(provider: "openai" | "anthropic" | "gemini", tools: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (provider === "gemini") {
    // config.tools = [{ functionDeclarations: [{ name, parameters }] }]
    if (!Array.isArray(tools)) return undefined;
    for (const group of tools as Array<{ functionDeclarations?: Array<{ name?: string; parameters?: unknown }> }>) {
      for (const fd of group?.functionDeclarations || []) {
        if (fd?.name && fd.parameters) out[fd.name] = fd.parameters;
      }
    }
  } else if (Array.isArray(tools)) {
    for (const t of tools as Array<{ name?: string; input_schema?: unknown; function?: { name?: string; parameters?: unknown } }>) {
      if (provider === "openai" && t.function?.name && t.function.parameters) out[t.function.name] = t.function.parameters;
      if (provider === "anthropic" && t.name && t.input_schema) out[t.name] = t.input_schema;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Capture the sampling/determinism envelope from the request options so replay-divergence (2A)
 * and regression replay (2E) can compare sampling config, not just the model. Normalizes provider
 * field names to { temperature, top_p, top_k, seed, max_tokens }. Returns undefined if none set.
 */
export function extractSamplingParams(provider: "openai" | "anthropic" | "gemini", opts: unknown): Record<string, unknown> | undefined {
  const o = (opts || {}) as Record<string, unknown>;
  const cfg = (provider === "gemini" ? (o.config as Record<string, unknown> | undefined) : o) || {};
  const out: Record<string, unknown> = {};
  const put = (key: string, v: unknown) => { if (v !== undefined && v !== null) out[key] = v; };
  if (provider === "gemini") {
    put("temperature", cfg.temperature);
    put("top_p", cfg.topP);
    put("top_k", cfg.topK);
    put("seed", cfg.seed);
    put("max_tokens", cfg.maxOutputTokens);
  } else {
    put("temperature", cfg.temperature);
    put("top_p", cfg.top_p);
    put("top_k", cfg.top_k); // anthropic only
    put("seed", cfg.seed); // openai only
    put("max_tokens", cfg.max_tokens ?? cfg.max_completion_tokens);
  }
  return Object.keys(out).length ? out : undefined;
}

function toolCallSpan(name: string, input: unknown, parentId: string | null, model: string | undefined, toolCallId?: string): SpanData {
  const now = nowIso();
  return {
    id: genId(), trace_id: "", parent_id: parentId,
    span_type: SpanType.TOOL_CALL, name: name || "tool",
    ...(model ? { model } : {}),
    input: truncateJson(input),
    started_at: now, ended_at: now, duration_ms: 0,
    ...(toolCallId ? { metadata: { tool_call_id: toolCallId } } : {}),
  };
}

function toolResultSpan(name: string, output: unknown, isError: boolean, toolCallId?: string): SpanData {
  const now = nowIso();
  return {
    id: genId(), trace_id: "", parent_id: null,
    span_type: SpanType.TOOL_RESULT, name: name || "tool_result",
    output: truncateJson(output),
    started_at: now, ended_at: now, duration_ms: 0,
    ...(isError ? { error: typeof output === "string" ? output : JSON.stringify(output) } : {}),
    ...(toolCallId ? { metadata: { tool_call_id: toolCallId } } : {}),
  };
}

// ─── OpenAI (chat.completions) ───────────────────────────────────────────────
interface OAToolCall { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }
interface OAMessage { role?: string; content?: unknown; tool_calls?: OAToolCall[]; tool_call_id?: string; name?: string }

/** Emit tool_call spans from an OpenAI assistant response message. */
export function emitOpenAIToolCalls(message: OAMessage | undefined, parentId: string, model: string | undefined, emit: Emit): void {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const c of calls) {
    const name = c.function?.name || "tool";
    emit(toolCallSpan(name, parseToolArgs(c.function?.arguments), parentId, model, c.id));
  }
}

/** Emit tool_result spans from OpenAI request messages (role:"tool"), deduped by tool_call_id. */
export function emitOpenAIToolResults(messages: OAMessage[] | undefined, emit: Emit): void {
  if (!Array.isArray(messages)) return;
  // Map tool_call_id -> tool name from any assistant tool_calls in the same message list.
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c.id) nameById.set(c.id, c.function?.name || "tool");
    }
  }
  for (const m of messages) {
    if (m?.role !== "tool" || !m.tool_call_id) continue;
    if (!markEmitted(`oa:${m.tool_call_id}`)) continue;
    const content = m.content;
    const isError = typeof content === "string" && /error|exception|failed/i.test(content);
    emit(toolResultSpan(nameById.get(m.tool_call_id) || m.name || "tool_result", content, isError, m.tool_call_id));
  }
}

// ─── Anthropic (messages) ────────────────────────────────────────────────────
interface AnthropicBlock { type?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface AnthropicMessage { role?: string; content?: unknown }

/** Emit tool_call spans from Anthropic response content blocks (type:"tool_use"). */
export function emitAnthropicToolCalls(content: unknown, parentId: string, model: string | undefined, emit: Emit): void {
  if (!Array.isArray(content)) return;
  for (const block of content as AnthropicBlock[]) {
    if (block?.type !== "tool_use") continue;
    emit(toolCallSpan(block.name || "tool", block.input, parentId, model, block.id));
  }
}

/** Emit tool_result spans from Anthropic request messages (content blocks type:"tool_result"). */
export function emitAnthropicToolResults(messages: AnthropicMessage[] | undefined, emit: Emit): void {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content as AnthropicBlock[]) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      if (!markEmitted(`anthropic:${block.tool_use_id}`)) continue;
      emit(toolResultSpan("tool_result", block.content, !!block.is_error, block.tool_use_id));
    }
  }
}

// ─── Gemini (generateContent) ────────────────────────────────────────────────
interface GeminiPart { functionCall?: { name?: string; args?: unknown }; functionResponse?: { name?: string; response?: unknown; id?: string } }

/** Emit tool_call spans from Gemini response candidate parts (functionCall). */
export function emitGeminiToolCalls(candidates: unknown, parentId: string, model: string | undefined, emit: Emit): void {
  if (!Array.isArray(candidates)) return;
  for (const cand of candidates as Array<{ content?: { parts?: GeminiPart[] } }>) {
    const parts = cand?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p.functionCall) continue;
      emit(toolCallSpan(p.functionCall.name || "tool", p.functionCall.args, parentId, model, p.functionCall.name));
    }
  }
}

/** Emit tool_result spans from Gemini request contents (functionResponse parts), deduped. */
export function emitGeminiToolResults(contents: unknown, emit: Emit): void {
  const list = Array.isArray(contents) ? contents : contents != null ? [contents] : [];
  for (const c of list as Array<{ parts?: GeminiPart[] }>) {
    const parts = c?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const fr = p.functionResponse;
      if (!fr) continue;
      const key = `gemini:${fr.id || fr.name || JSON.stringify(fr.response).slice(0, 64)}`;
      if (!markEmitted(key)) continue;
      emit(toolResultSpan(fr.name || "tool_result", fr.response, false, fr.id || fr.name));
    }
  }
}
