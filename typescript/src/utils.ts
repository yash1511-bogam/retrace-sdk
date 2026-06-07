import { randomUUID } from "crypto";

export function genId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function utcNow(): Date {
  return new Date();
}

/**
 * Deterministic sampling decision using FNV-1a hash.
 * When a seed is provided, the same (seed + key) always produces the same decision.
 * Without a seed, falls back to Math.random() for backward compatibility.
 */
export function shouldSample(rate: number, seed?: string, key?: string): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  if (!seed) return Math.random() < rate;
  // FNV-1a hash of seed+key → deterministic float in [0,1)
  const input = `${seed}:${key || Date.now()}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) < rate;
}

export function truncateJson(obj: unknown, maxBytes = 10240): unknown {
  try {
    const s = JSON.stringify(obj);
    if (Buffer.byteLength(s) <= maxBytes) return obj;
    return JSON.parse(Buffer.from(s).subarray(0, maxBytes).toString());
  } catch {
    return String(obj).slice(0, maxBytes);
  }
}

/** True if truncateJson(obj, maxBytes) would drop bytes. Used to flag a span's output as truncated
 *  so the server refuses to byte-replay it (the replayed value would differ from the original). */
export function wasTruncated(obj: unknown, maxBytes = 10240): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(obj)) > maxBytes;
  } catch {
    return String(obj).length > maxBytes;
  }
}

/** Default per-span-type truncation limits (bytes). */
const DEFAULT_TRUNCATION_LIMITS: Record<string, number> = {
  llm_call: 51200,    // 50KB — LLM prompts can be large
  tool_call: 10240,   // 10KB
  tool_result: 10240, // 10KB
  reasoning: 20480,   // 20KB
  action: 5120,       // 5KB
  error: 5120,        // 5KB
};

let customTruncationLimits: Record<string, number> = {};

/** Configure per-span-type truncation limits. */
export function setTruncationLimits(limits: Record<string, number>): void {
  customTruncationLimits = limits;
}

/** Get the truncation limit for a given span type. */
export function getTruncationLimit(spanType: string): number {
  return customTruncationLimits[spanType] || DEFAULT_TRUNCATION_LIMITS[spanType] || 10240;
}

/** Truncate payload based on span type. */
export function truncateForSpanType(obj: unknown, spanType: string): unknown {
  return truncateJson(obj, getTruncationLimit(spanType));
}
