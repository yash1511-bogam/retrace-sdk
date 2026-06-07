import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson, wasTruncated } from "../utils.js";
import { isReplaying, consumeCassetteEntry } from "../replay.js";
import { getConfig } from "../config.js";
import { RetraceRateLimitError, RetraceAuthError, RetraceConnectionError } from "../errors.js";
import { emitOpenAIToolCalls, emitOpenAIToolResults, parseToolArgs, resetToolResultDedup, extractToolSchemas, extractSamplingParams } from "./tool-spans.js";
import { dispatchRegisterOpenSpan, dispatchUnregisterOpenSpan } from "./_dispatch.js";

/** Hardcoded fallback pricing ($/1M tokens: [input, output]). Updated periodically. */
const FALLBACK_PRICING: Record<string, [number, number]> = {
  "gpt-5.5-pro": [30.0, 180.0],
  "gpt-5.5": [5.0, 30.0],
  "gpt-5.4-pro": [15.0, 90.0],
  "gpt-5.4-mini": [0.75, 4.50],
  "gpt-5.4-nano": [0.20, 1.20],
  "gpt-5.4": [2.50, 15.0],
  "gpt-5-mini": [0.50, 3.0],
  "gpt-5-nano": [0.10, 0.60],
  "gpt-5": [1.25, 10.0],
  "gpt-4.1-mini": [0.40, 1.60],
  "gpt-4.1-nano": [0.10, 0.40],
  "gpt-4.1": [2.0, 8.0],
  "gpt-4o-mini": [0.15, 0.60],
  "gpt-4o": [2.50, 10.0],
  "o3": [10.0, 40.0],
  "o4-mini": [1.10, 4.40],
  "o3-mini": [1.10, 4.40],
};

let livePricing: Record<string, [number, number]> | null = null;
let pricingFetchedAt = 0;
const PRICING_TTL_MS = 3600_000; // Refresh every hour

/** Fetch live pricing from Retrace API. Falls back to hardcoded on failure. */
async function fetchPricing(): Promise<Record<string, [number, number]>> {
  if (livePricing && Date.now() - pricingFetchedAt < PRICING_TTL_MS) return livePricing;
  try {
    const cfg = getConfig();
    const res = await fetch(`${cfg.baseUrl}/api/v1/pricing/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") {
        livePricing = data as Record<string, [number, number]>;
        pricingFetchedAt = Date.now();
        return livePricing;
      }
    }
  } catch { /* silent — use fallback */ }
  return FALLBACK_PRICING;
}

// Kick off initial fetch (non-blocking)
fetchPricing().catch(() => {});

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = livePricing || FALLBACK_PRICING;
  for (const [key, p] of Object.entries(pricing)) {
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

export function installOpenAIInterceptor(onSpan: (span: SpanData) => void) {
  // Always refresh the active callback; the prototype PATCH must happen at most once. The guard is
  // a synchronous flag set before import() so two concurrent installs (e.g. two recorders starting
  // before "openai" resolves) can't both patch and double-wrap create() → doubled spans/billing.
  onSpanCallback = onSpan;
  resetToolResultDedup();
  if (installStarted) return;
  installStarted = true;

  import("openai").then((openaiMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = openaiMod as any;
    const proto = mod?.OpenAI?.Chat?.Completions?.prototype || mod?.default?.Chat?.Completions?.prototype;
    if (!proto?.create) {
      // Try accessing prototype chain without instantiation
      const OpenAI = mod?.OpenAI || mod?.default;
      if (OpenAI?.prototype?.chat) {
        const chatProto = Object.getPrototypeOf(Object.getPrototypeOf(OpenAI.prototype.chat)?.completions || {});
        if (chatProto?.create) {
          originalCreate = chatProto.create;
          chatProto.create = createPatchedCreate();
          installed = true;
        }
      }
      return;
    }
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
    const spanId = genId();
    const startedAt = nowIso();
    const startMs = Date.now();

    // Capture vision (image_url) and structured output (response_format) metadata
    const hasVision = messages.some((m: Record<string, unknown>) =>
      Array.isArray(m.content) && m.content.some((p: Record<string, unknown>) => p.type === "image_url")
    );
    const responseFormat = opts.response_format;
    const spanMetadata: Record<string, unknown> = {};
    if (hasVision) spanMetadata.vision = true;
    if (responseFormat) spanMetadata.structured_output = typeof responseFormat === "object" ? responseFormat.type || "json_schema" : responseFormat;
    // Capture declared tool parameter schemas so the detection engine can validate tool args.
    const toolSchemas = extractToolSchemas("openai", opts.tools);
    if (toolSchemas) spanMetadata.tool_schemas = toolSchemas;
    const sampling = extractSamplingParams("openai", opts);
    if (sampling) spanMetadata.sampling = sampling;

    // During replay, return mocked response from cassette instead of calling the real API
    if (isReplaying()) {
      const entry = consumeCassetteEntry("openai.chat.completions.create", "llm_call");
      if (entry) {
        const output = entry.output_raw ?? (typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output || ""));
        const span: SpanData = {
          id: spanId, trace_id: "", parent_id: null,
          span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
          input: truncateJson({ messages: messages.slice(0, 10) }),
          output: truncateJson(output),
          duration_ms: 0, started_at: startedAt, ended_at: nowIso(),
          metadata: { replayed: true },
        };
        onSpanCallback?.(span);
        return {
          id: `chatcmpl-replay-${spanId}`,
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
    }

    try {
      const result = await originalCreate!.apply(this, args);

      // Streaming response: wrap the async iterator to collect chunks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (isStreaming && result && typeof (result as any)[Symbol.asyncIterator] === "function") {
        const chunks: string[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        // Accumulate streamed tool calls by index (id/name arrive first, arguments stream in).
        const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const originalIterator = (result as any)[Symbol.asyncIterator]();

        // Two-phase capture: register an OPEN span now and finalize EXACTLY ONCE — on clean drain
        // (complete), on early break / error (partial), or at trace-end/exit (partial, via the sink).
        // Previously the span was emitted only in the `done` branch, so an abandoned or errored
        // stream silently lost its span entirely.
        let finalized = false;
        const finalize = (reason: "complete" | "partial") => {
          if (finalized) return;
          finalized = true;
          dispatchUnregisterOpenSpan(spanId);
          const durationMs = Date.now() - startMs;
          const output = chunks.join("");
          const span: SpanData = {
            id: spanId, trace_id: "", parent_id: null,
            span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
            input: truncateJson({ messages: messages.slice(0, 10) }),
            output: truncateJson(output),
            input_tokens: inputTokens, output_tokens: outputTokens,
            cost: calcCost(model, inputTokens, outputTokens),
            duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
            metadata: { streaming: true, ...(reason === "partial" ? { partial: true } : {}), ...(wasTruncated(output) ? { truncated: true } : {}), ...(toolSchemas ? { tool_schemas: toolSchemas } : {}), ...(sampling ? { sampling } : {}) },
          };
          onSpanCallback?.(span);
          if (onSpanCallback && reason === "complete") {
            emitOpenAIToolResults(messages, onSpanCallback);
            const accMsg = { tool_calls: Object.values(toolAcc).map((t) => ({ id: t.id, function: { name: t.name, arguments: parseToolArgs(t.args) } })) };
            emitOpenAIToolCalls(accMsg, spanId, model, onSpanCallback);
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
                // Collect content delta
                const delta = value?.choices?.[0]?.delta?.content;
                if (delta) chunks.push(delta);
                // Collect streamed tool-call deltas (function name/id, then argument fragments)
                const tcDeltas = value?.choices?.[0]?.delta?.tool_calls;
                if (Array.isArray(tcDeltas)) {
                  for (const tc of tcDeltas) {
                    const idx = typeof tc.index === "number" ? tc.index : 0;
                    const acc = (toolAcc[idx] ??= { args: "" });
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.name = tc.function.name;
                    if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
                  }
                }
                // Collect usage from final chunk
                if (value?.usage) {
                  inputTokens = value.usage.prompt_tokens || 0;
                  outputTokens = value.usage.completion_tokens || 0;
                }
                return { value, done: false };
              },
              // Early break (consumer stops iterating) and errors must still finalize the span —
              // otherwise the streamed work is silently lost.
              return() { finalize("partial"); return originalIterator.return?.() ?? Promise.resolve({ value: undefined, done: true }); },
              throw(e: unknown) { finalize("partial"); return originalIterator.throw?.(e) ?? Promise.reject(e); },
            };
          },
          // Preserve tee/controller methods if present
          ...((result as Record<string, unknown>).controller ? { controller: (result as Record<string, unknown>).controller } : {}),
        };
        return wrappedStream;
      }

      // Non-streaming response
      const durationMs = Date.now() - startMs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = result as any;
      const inputTokens = res?.usage?.prompt_tokens || 0;
      const outputTokens = res?.usage?.completion_tokens || 0;
      const output = res?.choices?.[0]?.message?.content || "";

      // Extract token IDs and logprobs if available (requires logprobs: true in request)
      const choiceLogprobs = res?.choices?.[0]?.logprobs?.content;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenIds: number[] | undefined = choiceLogprobs?.map((t: any) => t.token_id ?? t.top_logprobs?.[0]?.token_id).filter(Boolean);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logprobValues: number[] | undefined = choiceLogprobs?.map((t: any) => t.logprob).filter((v: any) => v !== undefined);

      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
        input: truncateJson({ messages: messages.slice(0, 10), ...(responseFormat ? { response_format: responseFormat } : {}) }),
        output: truncateJson(output),
        input_tokens: inputTokens, output_tokens: outputTokens,
        cost: calcCost(model, inputTokens, outputTokens),
        duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
        ...(tokenIds?.length ? { token_ids: tokenIds } : {}),
        ...(logprobValues?.length ? { logprobs: logprobValues } : {}),
        ...(Object.keys(spanMetadata).length || wasTruncated(output) ? { metadata: { ...spanMetadata, ...(wasTruncated(output) ? { truncated: true } : {}) } } : {}),
      };
      onSpanCallback?.(span);
      // Auto-capture tool usage: tool_result spans from the fed-back tool messages (deduped),
      // tool_call spans from the model's requested calls (structured args).
      if (onSpanCallback) {
        emitOpenAIToolResults(messages, onSpanCallback);
        emitOpenAIToolCalls(res?.choices?.[0]?.message, spanId, model, onSpanCallback);
      }
      return result;
    } catch (err) {
      const span: SpanData = {
        id: spanId, trace_id: "", parent_id: null,
        span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
        input: truncateJson({ messages: messages.slice(0, 10) }),
        started_at: startedAt, ended_at: nowIso(),
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
      onSpanCallback?.(span);
      // Wrap provider errors in typed Retrace exceptions for user-facing clarity
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (err as any)?.status || (err as any)?.response?.status;
      if (status === 429) throw new RetraceRateLimitError(parseInt((err as Record<string, Record<string, string>>)?.headers?.["retry-after"] || "60", 10));
      if (status === 401 || status === 403) throw new RetraceAuthError(`OpenAI auth failed: ${(err as Error).message}`);
      if ((err as Error)?.message?.includes("ECONNREFUSED") || (err as Error)?.message?.includes("fetch failed")) {
        throw new RetraceConnectionError(`OpenAI connection failed: ${(err as Error).message}`);
      }
      throw err;
    }
  };
}

export function uninstallOpenAIInterceptor() {
  if (!installed || !originalCreate) return;
  import("openai").then((openaiMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = openaiMod as any;
    const proto = mod?.OpenAI?.Chat?.Completions?.prototype || mod?.default?.Chat?.Completions?.prototype;
    if (proto) proto.create = originalCreate;
  }).catch(() => {});
  installed = false;
  onSpanCallback = null;
}
