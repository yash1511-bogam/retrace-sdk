import { SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";
const PRICING = {
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
function calcCost(model, inputTokens, outputTokens) {
    for (const [key, p] of Object.entries(PRICING)) {
        if (model.includes(key))
            return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
    }
    return 0;
}
let originalCreate = null;
let installed = false;
let onSpanCallback = null;
export function installOpenAIInterceptor(onSpan) {
    if (installed) {
        onSpanCallback = onSpan;
        return;
    }
    onSpanCallback = onSpan;
    import("openai").then((openaiMod) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = openaiMod;
        const proto = mod?.OpenAI?.Chat?.Completions?.prototype || mod?.default?.Chat?.Completions?.prototype;
        if (!proto?.create) {
            // Try alternative path
            const OpenAI = mod?.OpenAI || mod?.default;
            if (OpenAI) {
                const instance = Object.getPrototypeOf(new OpenAI({ apiKey: "dummy" }).chat.completions);
                if (instance?.create) {
                    originalCreate = instance.create;
                    instance.create = createPatchedCreate();
                    installed = true;
                }
            }
            return;
        }
        originalCreate = proto.create;
        proto.create = createPatchedCreate();
        installed = true;
    }).catch(() => { });
}
function createPatchedCreate() {
    return async function (...args) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opts = args[0] || {};
        const model = opts.model || "unknown";
        const messages = opts.messages || [];
        const spanId = genId();
        const startedAt = nowIso();
        const startMs = Date.now();
        try {
            const result = await originalCreate.apply(this, args);
            const durationMs = Date.now() - startMs;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = result;
            const inputTokens = res?.usage?.prompt_tokens || 0;
            const outputTokens = res?.usage?.completion_tokens || 0;
            const output = res?.choices?.[0]?.message?.content || "";
            const span = {
                id: spanId, trace_id: "", parent_id: null,
                span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
                input: truncateJson({ messages: messages.slice(0, 10) }),
                output: truncateJson(output),
                input_tokens: inputTokens, output_tokens: outputTokens,
                cost: calcCost(model, inputTokens, outputTokens),
                duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
            };
            onSpanCallback?.(span);
            return result;
        }
        catch (err) {
            const span = {
                id: spanId, trace_id: "", parent_id: null,
                span_type: SpanType.LLM_CALL, name: "openai.chat.completions.create", model,
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
export function uninstallOpenAIInterceptor() {
    if (!installed || !originalCreate)
        return;
    import("openai").then((openaiMod) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = openaiMod;
        const proto = mod?.OpenAI?.Chat?.Completions?.prototype || mod?.default?.Chat?.Completions?.prototype;
        if (proto)
            proto.create = originalCreate;
    }).catch(() => { });
    installed = false;
    onSpanCallback = null;
}
