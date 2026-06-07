import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson, wasTruncated } from "../utils.js";
import { isReplaying, consumeCassetteEntry } from "../replay.js";
import { emitAnthropicToolCalls, emitAnthropicToolResults, parseToolArgs, resetToolResultDedup, extractToolSchemas, extractSamplingParams } from "./tool-spans.js";
import { dispatchRegisterOpenSpan, dispatchUnregisterOpenSpan } from "./_dispatch.js";

const PRICING: Record<string, [number, number]> = {
  "claude-opus-4.7": [5.0, 25.0],
  "claude-opus-4.6": [5.0, 25.0],
  "claude-sonnet-4.6": [3.0, 15.0],
  "claude-sonnet-4": [3.0, 15.0],
  "claude-haiku-4.5": [1.0, 5.0],
  "claude-3-7-sonnet": [3.0, 15.0],
  "claude-3-5-sonnet": [3.0, 15.0],
  "claude-3-5-haiku": [0.80, 4.0],
  "claude-3-opus": [15.0, 75.0],
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  for (const [key, p] of Object.entries(PRICING)) {
    if (model.includes(key)) return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
  }
  return 0;
}

let originalCreate: ((...args: unknown[]) => unknown) | null = null;
let installed = false;
// Set SYNCHRONOUSLY before the async import() so a second concurrent install can't double-wrap the
// prototype. (`installed` is set inside the .then() and is therefore too late to guard the race.)
let installStarted = false;
let onSpanCallback: ((span: SpanData) => void) | null = null;

export function installAnthropicInterceptor(onSpan: (span: SpanData) => void) {
  // Always refresh the active callback; the prototype PATCH must happen at most once (a synchronous
  // guard so two concurrent installs can't both patch and double-wrap create() → doubled spans).
  onSpanCallback = onSpan;
  resetToolResultDedup();
  if (installStarted) return;
  installStarted = true;

  import("@anthropic-ai/sdk").then((anthropicMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = anthropicMod as any;
    const Anthropic = mod?.Anthropic || mod?.default;
    if (!Anthropic) return;
    // Find Messages prototype without instantiating a client
    const proto = Anthropic.Messages?.prototype || Anthropic.prototype?.messages?.constructor?.prototype;
    if (!proto?.create) return;
    originalCreate = proto.create;
    proto.create = createPatchedCreate();
    installed = true;
  }).catch(() => { installStarted = false; });
}

function createPatchedCreate() {
  return async function (this: unknown, ...args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (args[0] as Record<string, any>) || {};
    const model = (opts.model as string) || "unknown";
    const messages = opts.messages || [];
    const isStreaming = !!opts.stream;
    const toolSchemas = extractToolSchemas("anthropic", opts.tools);
    const sampling = extractSamplingParams("anthropic", opts);
    const spanMeta = { ...(toolSchemas ? { tool_schemas: toolSchemas } : {}), ...(sampling ? { sampling } : {}) };
    const spanId = genId();
    const startedAt = nowIso();
    const startMs = Date.now();

    // During replay, return mocked response from cassette
    if (isReplaying()) {
      const entry = consumeCassetteEntry("anthropic.messages.create", "llm_call");
      if (entry) {
        const output = entry.output_raw ?? (typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output || ""));
        const span: SpanData = {
          id: spanId, trace_id: "", parent_id: null,
          span_type: SpanType.LLM_CALL, name: "anthropic.messages.create", model,
          input: truncateJson({ messages: messages.slice(0, 10) }),
          output: truncateJson(output),
          duration_ms: 0, started_at: startedAt, ended_at: nowIso(),
          metadata: { replayed: true },
        };
        onSpanCallback?.(span);
        return {
          id: `msg-replay-${spanId}`, type: "message", role: "assistant", model,
          content: [{ type: "text", text: output }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "end_turn",
        };
      }
    }

    try {
      const result = await originalCreate!.apply(this, args);

      // Streaming: Anthropic returns an async iterable of MessageStreamEvent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (isStreaming && result && typeof (result as any)[Symbol.asyncIterator] === "function") {
        const chunks: string[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        // Accumulate streamed tool_use blocks by index (content_block_start + input_json_delta).
        const toolAcc: Record<number, { id?: string; name?: string; json: string }> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const originalIterator = (result as any)[Symbol.asyncIterator]();

        // Two-phase capture: finalize EXACTLY ONCE on clean drain (complete), early break / error
        // (partial), or trace-end/exit (partial, via the sink) — never silently drop the span.
        let finalized = false;
        const finalize = (reason: "complete" | "partial") => {
          if (finalized) return;
          finalized = true;
          dispatchUnregisterOpenSpan(spanId);
          const durationMs = Date.now() - startMs;
          const output = chunks.join("");
          const span: SpanData = {
            id: spanId, trace_id: "", parent_id: null,
            span_type: SpanType.LLM_CALL, name: "anthropic.messages.create", model,
            input: truncateJson({ messages: messages.slice(0, 10) }),
            output: truncateJson(output),
            input_tokens: inputTokens, output_tokens: outputTokens,
            cost: calcCost(model, inputTokens, outputTokens),
            duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
            metadata: { streaming: true, ...(reason === "partial" ? { partial: true } : {}), ...(wasTruncated(output) ? { truncated: true } : {}), ...spanMeta },
          };
          onSpanCallback?.(span);
          if (onSpanCallback && reason === "complete") {
            emitAnthropicToolResults(messages, onSpanCallback);
            const blocks = Object.values(toolAcc).map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: parseToolArgs(t.json) }));
            emitAnthropicToolCalls(blocks, spanId, model, onSpanCallback);
          }
        };
        dispatchRegisterOpenSpan(spanId, () => finalize("partial"));

        const wrappedStream = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const { value, done } = await originalIterator.next();
                if (done) {
                  finalize("complete");
                  return { value: undefined, done: true };
                }
                // Collect content_block_delta text
                if (value?.type === "content_block_delta" && value?.delta?.text) {
                  chunks.push(value.delta.text);
                }
                // Accumulate tool_use blocks (start carries id/name, input_json_delta streams args)
                if (value?.type === "content_block_start" && value?.content_block?.type === "tool_use") {
                  toolAcc[value.index ?? 0] = { id: value.content_block.id, name: value.content_block.name, json: "" };
                }
                if (value?.type === "content_block_delta" && value?.delta?.type === "input_json_delta") {
                  const acc = toolAcc[value.index ?? 0];
                  if (acc && typeof value.delta.partial_json === "string") acc.json += value.delta.partial_json;
                }
                // Collect usage from message_delta
                if (value?.type === "message_delta" && value?.usage) {
                  outputTokens = value.usage.output_tokens || outputTokens;
                }
                // Collect input tokens from message_start
                if (value?.type === "message_start" && value?.message?.usage) {
                  inputTokens = value.message.usage.input_tokens || 0;
                }
                return { value, done: false };
              },
              return() { finalize("partial"); return originalIterator.return?.() ?? Promise.resolve({ value: undefined, done: true }); },
              throw(e: unknown) { finalize("partial"); return originalIterator.throw?.(e) ?? Promise.reject(e); },
            };
          },
        };
        return wrappedStream;
      }

      // Non-streaming response
      const durationMs = Date.now() - startMs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = result as any;
      const inputTokens = res?.usage?.input_tokens || 0;
      const outputTokens = res?.usage?.output_tokens || 0;
      const output = res?.content?.[0]?.text || "";

      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "anthropic.messages.create", model,
        input: truncateJson({ messages: messages.slice(0, 10) }),
        output: truncateJson(output),
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost: calcCost(model, inputTokens, outputTokens),
        duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
        ...(Object.keys(spanMeta).length || wasTruncated(output) ? { metadata: { ...spanMeta, ...(wasTruncated(output) ? { truncated: true } : {}) } } : {}),
      };
      onSpanCallback?.(span);
      // Auto-capture tool usage (tool_use blocks in response, tool_result blocks in input).
      if (onSpanCallback) {
        emitAnthropicToolResults(messages, onSpanCallback);
        emitAnthropicToolCalls(res?.content, spanId, model, onSpanCallback);
      }
      return result;
    } catch (err) {
      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "anthropic.messages.create", model,
        input: truncateJson({ messages: messages.slice(0, 10) }),
        started_at: startedAt, ended_at: nowIso(),
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
      onSpanCallback?.(span);
      throw err;
    }
  };
}

export function uninstallAnthropicInterceptor() {
  if (!installed || !originalCreate) return;
  import("@anthropic-ai/sdk").then((anthropicMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = anthropicMod as any;
    const Anthropic = mod?.Anthropic || mod?.default;
    if (!Anthropic) return;
    const proto = Anthropic.Messages?.prototype;
    if (proto) proto.create = originalCreate;
  }).catch(() => {});
  installed = false;
  onSpanCallback = null;
}
