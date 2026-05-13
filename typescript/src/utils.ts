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

export function truncateJson(obj: unknown, maxBytes = 10240): unknown {
  try {
    const s = JSON.stringify(obj);
    if (Buffer.byteLength(s) <= maxBytes) return obj;
    return JSON.parse(Buffer.from(s).subarray(0, maxBytes).toString());
  } catch {
    return String(obj).slice(0, maxBytes);
  }
}
