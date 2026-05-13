import { SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";
const PRICING = {
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
export function installAnthropicInterceptor(onSpan) {
    if (installed) {
        onSpanCallback = onSpan;
        return;
    }
    onSpanCallback = onSpan;
    import("@anthropic-ai/sdk").then((anthropicMod) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = anthropicMod;
        const Anthropic = mod?.Anthropic || mod?.default;
        if (!Anthropic)
            return;
        const proto = Anthropic.Messages?.prototype || Object.getPrototypeOf(new Anthropic({ apiKey: "dummy" }).messages);
        if (!proto?.create)
            return;
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
            const inputTokens = res?.usage?.input_tokens || 0;
            const outputTokens = res?.usage?.output_tokens || 0;
            const output = res?.content?.[0]?.text || "";
            const span = {
                id: spanId, trace_id: "", parent_id: null,
                span_type: SpanType.LLM_CALL, name: "anthropic.messages.create", model,
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
    if (!installed || !originalCreate)
        return;
    import("@anthropic-ai/sdk").then((anthropicMod) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = anthropicMod;
        const Anthropic = mod?.Anthropic || mod?.default;
        if (!Anthropic)
            return;
        const proto = Anthropic.Messages?.prototype;
        if (proto)
            proto.create = originalCreate;
    }).catch(() => { });
    installed = false;
    onSpanCallback = null;
}
