import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";
import { isReplaying, consumeCassetteEntry } from "../replay.js";
import { getConfig } from "../config.js";
import { RetraceRateLimitError, RetraceAuthError, RetraceConnectionError } from "../errors.js";

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
let onSpanCallback: ((span: SpanData) => void) | null = null;

export function installOpenAIInterceptor(onSpan: (span: SpanData) => void) {
  if (installed) { onSpanCallback = onSpan; return; }
  onSpanCallback = onSpan;

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
  }).catch(() => {});
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

    // During replay, return mocked response from cassette instead of calling the real API
    if (isReplaying()) {
      const entry = consumeCassetteEntry("openai.chat.completions.create", "llm_call");
      if (entry) {
        const output = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output || "");
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const originalIterator = (result as any)[Symbol.asyncIterator]();

        const wrappedStream = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const { value, done } = await originalIterator.next();
                if (done) {
                  // Stream complete — emit span
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
                    metadata: { streaming: true },
                  };
                  onSpanCallback?.(span);
                  return { value: undefined, done: true };
                }
                // Collect content delta
                const delta = value?.choices?.[0]?.delta?.content;
                if (delta) chunks.push(delta);
                // Collect usage from final chunk
                if (value?.usage) {
                  inputTokens = value.usage.prompt_tokens || 0;
                  outputTokens = value.usage.completion_tokens || 0;
                }
                return { value, done: false };
              },
              return() { return originalIterator.return?.() ?? Promise.resolve({ value: undefined, done: true }); },
              throw(e: unknown) { return originalIterator.throw?.(e) ?? Promise.reject(e); },
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
        ...(Object.keys(spanMetadata).length ? { metadata: spanMetadata } : {}),
      };
      onSpanCallback?.(span);
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
