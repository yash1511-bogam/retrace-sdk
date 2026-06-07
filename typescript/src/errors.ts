export class RetraceError extends Error {
  constructor(message: string) { super(message); this.name = "RetraceError"; }
}

export class RetraceAuthError extends RetraceError {
  constructor(message = "Invalid or missing API key") { super(message); this.name = "RetraceAuthError"; }
}

export class RetraceCreditsExhaustedError extends RetraceError {
  constructor(message = "Monthly trace limit reached. Upgrade at retrace.yashbogam.me/pricing") { super(message); this.name = "RetraceCreditsExhaustedError"; }
}

export class RetraceConnectionError extends RetraceError {
  constructor(message = "Failed to connect to Retrace API") { super(message); this.name = "RetraceConnectionError"; }
}

export class RetraceRateLimitError extends RetraceError {
  retryAfter: number;
  constructor(retryAfter: number) { super(`Rate limited. Retry after ${retryAfter}s`); this.name = "RetraceRateLimitError"; this.retryAfter = retryAfter; }
}

/**
 * Structured server-originated signal handed to `onError`. Actionable WITHOUT string-matching:
 * branch on `code`, decide retry from `retryable`, decide whether recording is still alive from
 * `fatal`. (A raw message alone forces the user to string-match — this type exists to avoid that.)
 */
export type RetraceSignalCode = "credits_exhausted" | "rate_limited" | "halt" | "error";

export interface RetraceServerSignal {
  /** Machine-readable category — branch on THIS, never on `message`. */
  code: RetraceSignalCode;
  /** Human-readable detail from the server. */
  message: string;
  /** Will retrying / backing off plausibly succeed? rate_limited=true; credits/halt/error=false. */
  retryable: boolean;
  /** Did this STOP recording? halt=true (transport closed); others leave recording alive. */
  fatal: boolean;
}

/**
 * Map a raw server frame to a structured signal. Single source of truth for category + retryable +
 * fatal, shared by the WS dispatch. Kept here (not inline in the dispatch) so TS and Python classify
 * identically and the CI gate can assert the mapping.
 */
export function classifyServerSignal(rawType: string, message: string): RetraceServerSignal {
  if (rawType === "halt") {
    return { code: "halt", message: message || "Guardrail triggered", retryable: false, fatal: true };
  }
  // rawType === "error" (or anything else carrying an error string)
  if (message?.includes("limit reached")) {
    return { code: "credits_exhausted", message, retryable: false, fatal: false };
  }
  if (message?.includes("Rate limit")) {
    return { code: "rate_limited", message, retryable: true, fatal: false };
  }
  return { code: "error", message: message || "Server error", retryable: false, fatal: false };
}
