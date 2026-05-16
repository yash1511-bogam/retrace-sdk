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
