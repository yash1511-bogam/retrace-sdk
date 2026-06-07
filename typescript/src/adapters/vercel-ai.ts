import { SpanType, type SpanData } from "../trace.js";
import { genId, nowIso } from "../utils.js";
import { getActiveRecorder } from "../init.js";
import type { TraceRecorder } from "../recorder.js";

/**
 * Vercel AI SDK adapter for Retrace.
 *
 * The AI SDK talks to providers through its own `@ai-sdk/*` packages (not the raw OpenAI/Anthropic
 * SDKs), so the provider interceptors don't see those calls. This adapter records the LLM step plus
 * structured `tool_call` / `tool_result` spans from the AI SDK's per-step callback, aligned with the
 * detectors. Drop it into `generateText` / `streamText`:
 *
 * ```ts
 * import { init } from "retrace-sdk";
 * import { retraceOnStepFinish } from "retrace-sdk/adapters/vercel-ai";
 * init();
 * await generateText({ model, prompt, tools, onStepFinish: retraceOnStepFinish() });
 * ```
 */
interface AISDKToolCall { toolName?: string; toolCallId?: string; args?: unknown }
interface AISDKToolResult { toolName?: string; toolCallId?: string; result?: unknown }
interface AISDKUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number }
export interface AISDKStep {
  text?: string;
  toolCalls?: AISDKToolCall[];
  toolResults?: AISDKToolResult[];
  usage?: AISDKUsage;
  finishReason?: string;
}

/** Record one AI SDK step (LLM output + tool calls/results) into the trace. */
export function recordVercelStep(step: AISDKStep, recorder?: TraceRecorder): void {
  const rec = recorder ?? getActiveRecorder();
  if (!rec) return;

  // LLM step — the AI SDK call the provider interceptors don't see; emit with token usage.
  const now = nowIso();
  const llm: SpanData = {
    id: genId(), trace_id: "", parent_id: null,
    span_type: SpanType.LLM_CALL, name: "ai.generate",
    output: step.text ?? "",
    input_tokens: step.usage?.promptTokens,
    output_tokens: step.usage?.completionTokens,
    started_at: now, ended_at: now,
  };
  rec.addSpan(llm);

  for (const call of step.toolCalls ?? []) {
    const sb = rec.startSpan(call.toolName || "tool", SpanType.TOOL_CALL, call.args);
    rec.endSpan(sb, undefined);
  }
  for (const res of step.toolResults ?? []) {
    const sb = rec.startSpan(res.toolName || "tool_result", SpanType.TOOL_RESULT, undefined);
    rec.endSpan(sb, res.result);
  }
}

/** Returns an `onStepFinish` callback for `generateText` / `streamText`. */
export function retraceOnStepFinish(recorder?: TraceRecorder): (step: AISDKStep) => void {
  return (step: AISDKStep) => recordVercelStep(step, recorder);
}
