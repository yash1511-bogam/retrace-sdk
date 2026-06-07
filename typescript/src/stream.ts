/**
 * `stream()` — opt-in full-fidelity wrapper for an LLM stream.
 *
 * Wrap a provider stream so that the auto-captured span observes a CLEAN full drain even if you stop
 * iterating early — giving you a byte-replay-eligible span (`capture_complete: true`) for a stream you
 * only partially consume:
 *
 * ```ts
 * for await (const chunk of stream(ai.models.generateContentStream({ ... }))) {
 *   render(chunk);
 *   if (enough) break;   // the rest is still drained in the background → full capture
 * }
 * ```
 *
 * It does NOT record its own span — it relies on the auto-interceptor's capture. So the
 * function-call rule still applies: a stream that emits a function call stays
 * `capture_complete: false` regardless of how it's drained. The helper's guarantee is
 * "true when there is no function call", never "true, period" — it can't force a function-call
 * stream to look byte-replayable.
 *
 * Opt-in cost: if you break early, the remainder of the stream is still consumed (the provider may
 * bill for the full generation) — so wrapping with `stream()` TRADES AWAY the cost/latency savings
 * of your early stop in exchange for guaranteed full-fidelity capture. If you broke early to save
 * money, do not wrap with `stream()`.
 */
export async function* stream<T>(src: AsyncIterable<T> | Promise<AsyncIterable<T>>): AsyncGenerator<T> {
  const iterable = (await src) as AsyncIterable<T>;
  const it = iterable[Symbol.asyncIterator]();
  let drainedToEnd = false;
  try {
    while (true) {
      const r = await it.next();
      if (r.done) { drainedToEnd = true; break; }
      yield r.value;
    }
  } finally {
    // Consumer broke early — finish draining the source so the auto-captured span sees a clean
    // drain. (Function-call streams still finalize capture_complete:false in the auto path.)
    if (!drainedToEnd) {
      try {
        for (;;) { const r = await it.next(); if (r.done) break; }
      } catch {
        /* best-effort drain */
      }
    }
  }
}
