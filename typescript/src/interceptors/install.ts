import { dispatchInterceptedSpan } from "./_dispatch.js";
import { installGeminiInterceptor } from "./gemini.js";
import { installOpenAIInterceptor } from "./openai.js";
import { installAnthropicInterceptor } from "./anthropic.js";

/**
 * Install ALL provider interceptors against the single stable dispatcher. Idempotent and memoized.
 * Called at import time and from configure()/init(). The Gemini interceptor patches retroactive
 * prototype methods, so the (async) install landing slightly after import is fine — capture works
 * regardless of when the user constructs their client.
 */
let _installPromise: Promise<void> | null = null;

export function ensureInterceptorsInstalled(): Promise<void> {
  if (_installPromise) return _installPromise;
  _installPromise = Promise.all([
    Promise.resolve(installGeminiInterceptor(dispatchInterceptedSpan)),
    Promise.resolve(installOpenAIInterceptor(dispatchInterceptedSpan)),
    Promise.resolve(installAnthropicInterceptor(dispatchInterceptedSpan)),
  ]).then(() => {});
  return _installPromise;
}
