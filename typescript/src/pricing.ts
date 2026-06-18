/**
 * Conservative fallback pricing for models not present in an interceptor's price table.
 *
 * A model that matches no key (a brand-new release, a fine-tune, an OpenRouter alias) would
 * otherwise be costed at $0 — and a $0 cost silently disarms USD budget ceilings in the enforcement
 * gate (the gate trips on estimated USD per run). We instead cost unknown models at a conservative
 * mid/high frontier rate so a budget cap still engages; the value self-corrects the moment the
 * server price table (synced via /api/v1/pricing/models) learns the model.
 *
 * $/1M tokens: [input, output].
 */
export const UNKNOWN_MODEL_PRICING: readonly [number, number] = [5.0, 15.0];

/** Cost in USD from an [input, output] $/1M-token rate. */
export function costFromRate(rate: readonly [number, number], inputTokens: number, outputTokens: number): number {
  return (inputTokens * rate[0] + outputTokens * rate[1]) / 1_000_000;
}
