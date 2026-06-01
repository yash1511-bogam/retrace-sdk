"""W3C Trace Context (traceparent) propagation for distributed tracing.

Format: 00-{trace_id_32hex}-{parent_id_16hex}-{flags_2hex}

When a traced function makes HTTP calls, inject the traceparent header
so downstream services can correlate their spans with the parent trace.
"""
from typing import Optional, Dict, Tuple

_current_trace_id: Optional[str] = None
_current_span_id: Optional[str] = None


def set_trace_context(trace_id: str, span_id: str) -> None:
    """Set the active trace context for outgoing requests."""
    global _current_trace_id, _current_span_id
    _current_trace_id = trace_id.replace("-", "")
    _current_span_id = span_id.replace("-", "")[:16]


def clear_trace_context() -> None:
    """Clear the active trace context."""
    global _current_trace_id, _current_span_id
    _current_trace_id = None
    _current_span_id = None


def get_traceparent() -> Optional[str]:
    """Get the current traceparent header value, or None if no active trace."""
    if not _current_trace_id or not _current_span_id:
        return None
    return f"00-{_current_trace_id}-{_current_span_id}-01"


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
