export { configure, getConfig } from "./config.js";
export { record, trace, TraceRecorder } from "./recorder.js";
export { SpanBuilder, TraceBuilder } from "./trace.js";
export type { SpanData, TraceData } from "./trace.js";
export { SpanType, TraceStatus } from "./trace.js";
export { installGeminiInterceptor, uninstallGeminiInterceptor } from "./interceptors/gemini.js";
export { installOpenAIInterceptor, uninstallOpenAIInterceptor } from "./interceptors/openai.js";
export { installAnthropicInterceptor, uninstallAnthropicInterceptor } from "./interceptors/anthropic.js";
export { RetraceError, RetraceAuthError, RetraceCreditsExhaustedError, RetraceConnectionError, RetraceRateLimitError } from "./errors.js";
export { registerResumable, handleResume } from "./resume.js";
export type { ResumeCommand } from "./resume.js";
export { isReplaying, consumeCassetteEntry, handleReplay } from "./replay.js";
export type { CassetteEntry, ReplayCommand } from "./replay.js";
export { setTraceContext, clearTraceContext, getTraceparent, injectTraceparent, parseTraceparent } from "./traceparent.js";
// v0.5.0
// trigger
