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
