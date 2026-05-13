import { SpanData, SpanType } from "../trace.js";
import { genId, nowIso, truncateJson } from "../utils.js";

const PRICING: Record<string, [number, number]> = {
  "gemini-3.1-flash-lite": [0.10, 0.40],
  "gemini-3.1-flash": [0.50, 3.0],
  "gemini-3-flash": [0.50, 3.0],
  "gemini-3-pro": [2.0, 12.0],
  "gemini-3.1-pro-preview": [2.0, 12.0],
  "gemini-2.5-pro": [1.25, 10.0],
  "gemini-2.5-flash": [0.30, 2.50],
  "gemini-2.5-flash-lite": [0.10, 0.40],
  "gemini-2.0-flash": [0.10, 0.40],
  "gemini-2.0-flash-lite": [0.05, 0.20],
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] || [0, 0];
  return (inputTokens * p[0] + outputTokens * p[1]) / 1_000_000;
}

 
let originalGenerateContent: ((...args: unknown[]) => unknown) | null = null;
let installed = false;
let onSpanCallback: ((span: SpanData) => void) | null = null;

export function installGeminiInterceptor(onSpan: (span: SpanData) => void) {
  if (installed) { onSpanCallback = onSpan; return; }
  onSpanCallback = onSpan;

  import("@google/genai").then((genaiMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = genaiMod as Record<string, any>;
    const modelsProto = mod?.Models?.prototype || mod?.default?.Models?.prototype;
    if (!modelsProto?.generateContent) return;

    originalGenerateContent = modelsProto.generateContent;

    modelsProto.generateContent = async function (...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (args[0] as Record<string, any>) || {};
      const model = (opts.model as string) || "unknown";
      const contents = opts.contents;
      const spanId = genId();
      const startedAt = nowIso();
      const startMs = Date.now();

      try {
        const result = await originalGenerateContent!.apply(this, args);
        const durationMs = Date.now() - startMs;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = result as any;
        const inputTokens = res?.usageMetadata?.promptTokenCount || 0;
        const outputTokens = res?.usageMetadata?.candidatesTokenCount || 0;

        const span: SpanData = {
          id: spanId, trace_id: "", parent_id: null,
          span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
          input: truncateJson(contents), output: truncateJson(res?.text || ""),
          input_tokens: inputTokens, output_tokens: outputTokens,
          cost: calcCost(model, inputTokens, outputTokens),
          duration_ms: durationMs, started_at: startedAt, ended_at: nowIso(),
        };
        onSpanCallback?.(span);
        return result;
      } catch (err) {
        const span: SpanData = {
          id: spanId, trace_id: "", parent_id: null,
          span_type: SpanType.LLM_CALL, name: "retrace.ai.generate", model,
          input: truncateJson(contents), started_at: startedAt, ended_at: nowIso(),
          duration_ms: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        };
        onSpanCallback?.(span);
        throw err;
      }
    };
    installed = true;
  }).catch(() => { /* @google/genai not installed — skip */ });
}

export function uninstallGeminiInterceptor() {
  if (!installed || !originalGenerateContent) return;
  import("@google/genai").then((genaiMod) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = genaiMod as Record<string, any>;
    const modelsProto = mod?.Models?.prototype || mod?.default?.Models?.prototype;
    if (modelsProto) modelsProto.generateContent = originalGenerateContent;
  }).catch(() => {});
  installed = false;
  onSpanCallback = null;
}
