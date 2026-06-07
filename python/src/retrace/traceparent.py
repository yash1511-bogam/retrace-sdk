"""W3C Trace Context (traceparent) propagation for distributed tracing.

Format: 00-{trace_id_32hex}-{parent_id_16hex}-{flags_2hex}

When a traced function makes HTTP calls, inject the traceparent header
so downstream services can correlate their spans with the parent trace.
"""
from typing import Dict, Optional, Tuple
import contextvars

# Per-context trace context (mirrors the _dispatch ContextVar). Each thread / async task resolves
# its own value, so concurrent traces can't leak context into one another's outbound requests.
_trace_ctx: contextvars.ContextVar[Optional[Tuple[str, str]]] = contextvars.ContextVar(
    "retrace_trace_ctx", default=None
)


def set_trace_context(trace_id: str, span_id: str):
    """Set the active trace context for outgoing requests. Returns a token for reset()."""
    return _trace_ctx.set((trace_id.replace("-", ""), span_id.replace("-", "")[:16]))


def clear_trace_context(token=None) -> None:
    """Clear the active trace context. Pass the token from set_trace_context to restore the
    enclosing context (supports nesting); otherwise the context is cleared outright."""
    if token is not None:
        try:
            _trace_ctx.reset(token)
            return
        except (ValueError, LookupError):
            pass
    _trace_ctx.set(None)


def get_traceparent() -> Optional[str]:
    """Get the current traceparent header value, or None if no active trace."""
    ctx = _trace_ctx.get()
    if not ctx:
        return None
    trace_id, span_id = ctx
    if not trace_id or not span_id:
        return None
    return f"00-{trace_id}-{span_id}-01"


def inject_traceparent(headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Inject traceparent into a headers dict for outgoing HTTP requests."""
    if headers is None:
        headers = {}
    tp = get_traceparent()
    if tp:
        headers["traceparent"] = tp
    return headers


def parse_traceparent(header: str) -> Optional[Tuple[str, str, bool]]:
    """Parse an incoming traceparent header.

    Returns (trace_id, parent_id, sampled) or None if invalid.
    """
    parts = header.split("-")
    if len(parts) != 4 or parts[0] != "00":
        return None
    if len(parts[1]) != 32 or len(parts[2]) != 16:
        return None
    return (parts[1], parts[2], parts[3] == "01")
