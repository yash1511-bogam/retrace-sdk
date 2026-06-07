class RetraceError(Exception):
    """Base error for Retrace SDK."""
    pass

class RetraceAuthError(RetraceError):
    """Invalid or missing API key."""
    def __init__(self, message="Invalid or missing API key"):
        super().__init__(message)

class RetraceCreditsExhaustedError(RetraceError):
    """Monthly trace/AI request limit reached."""
    def __init__(self, message="Monthly limit reached. Upgrade at retrace.yashbogam.me/pricing"):
        super().__init__(message)

class RetraceConnectionError(RetraceError):
    """Failed to connect to Retrace API."""
    def __init__(self, message="Failed to connect to Retrace API"):
        super().__init__(message)

class RetraceRateLimitError(RetraceError):
    """Rate limited by the API."""
    def __init__(self, retry_after: int = 60):
        self.retry_after = retry_after
        super().__init__(f"Rate limited. Retry after {retry_after}s")


from dataclasses import dataclass


@dataclass
class RetraceServerSignal:
    """Structured server-originated signal handed to ``on_error``. Actionable WITHOUT string-matching:
    branch on ``code``, decide retry from ``retryable``, decide whether recording is still alive from
    ``fatal``. Mirrors the TypeScript ``RetraceServerSignal`` exactly (parity is the point of #5).

    code:      one of "credits_exhausted" | "rate_limited" | "halt" | "error" — branch on THIS.
    message:   human-readable detail from the server.
    retryable: will retrying / backing off plausibly succeed? rate_limited=True; others False.
    fatal:     did this STOP recording? halt=True (transport closed); others leave recording alive.
    """
    code: str
    message: str
    retryable: bool
    fatal: bool


def classify_server_signal(raw_type: str, message: str) -> RetraceServerSignal:
    """Map a raw server frame to a structured signal. Single source of truth for category + retryable
    + fatal — identical mapping to the TS ``classifyServerSignal``."""
    if raw_type == "halt":
        return RetraceServerSignal(code="halt", message=message or "Guardrail triggered", retryable=False, fatal=True)
    if message and "limit reached" in message:
        return RetraceServerSignal(code="credits_exhausted", message=message, retryable=False, fatal=False)
    if message and "Rate limit" in message:
        return RetraceServerSignal(code="rate_limited", message=message, retryable=True, fatal=False)
    return RetraceServerSignal(code="error", message=message or "Server error", retryable=False, fatal=False)
