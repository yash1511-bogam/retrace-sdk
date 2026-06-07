export { configure, getConfig } from "./config.js";
export { init, getActiveRecorder, shutdown } from "./init.js";
export type { InitOptions } from "./init.js";
export { record, trace, TraceRecorder } from "./recorder.js";
export { stream } from "./stream.js";
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
export { setTraceContext, clearTraceContext, getTraceparent, injectTraceparent, parseTraceparent, withTraceContext } from "./traceparent.js";
export { markGolden } from "./golden.js";
// Framework adapters (5B) — drop-in instrumentation for LangChain/LangGraph + Vercel AI SDK.
export { createLangChainHandler } from "./adapters/langchain.js";
export { retraceOnStepFinish, recordVercelStep } from "./adapters/vercel-ai.js";
export type { AISDKStep } from "./adapters/vercel-ai.js";

// Patch provider SDKs at import (fire-and-forget; NO top-level await → CJS/bundler-safe). The Gemini
// interceptor patches RETROACTIVE prototype methods (generateContentInternal/...Stream), so capture
// works regardless of when the user constructs their client — including module-level clients built
// in the same tick. This matches the Python SDK: no ordering contract, no ready() footgun.
import { ensureInterceptorsInstalled } from "./interceptors/install.js";
void ensureInterceptorsInstalled();
// v0.5.0
// trigger
