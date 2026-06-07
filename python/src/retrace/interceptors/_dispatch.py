"""
Context-isolated routing for auto-instrumented spans.

The interceptors (openai/anthropic/gemini) are patched globally and call a single module
callback. Previously that callback was a module-global set per recorder (last-writer-wins),
so under concurrency intercepted LLM spans could be routed to the wrong trace. We instead
install ONE stable dispatcher whose target recorder lives in a ContextVar — each thread /
async task resolves its own active recorder, eliminating cross-trace contamination.
"""
from __future__ import annotations

import contextvars
from typing import Any, Callable, Optional

_active_recorder_cb: contextvars.ContextVar[Optional[Callable[[dict], Any]]] = contextvars.ContextVar(
    "retrace_active_recorder_cb", default=None
)
# The recorder acting as the open-span sink for the current context (two-phase streaming spans).
_active_open_sink: contextvars.ContextVar[Optional[Any]] = contextvars.ContextVar(
    "retrace_active_open_sink", default=None
)


def dispatch_intercepted_span(span_data: dict) -> None:
    """Stable interceptor callback — routes to the recorder active in the current context."""
    cb = _active_recorder_cb.get()
    if cb is not None:
        cb(span_data)


def capture_active_emit():
    """Capture the span sink active in THIS context (at invocation) so a deferred streaming
    finalizer can emit to the right recorder even when later resumed in a context where the
    ContextVar is absent (generator .close()/GeneratorExit, trace-end, atexit)."""
    return _active_recorder_cb.get()


def register_open_span(span_id: str, finalize) -> None:
    """Register an open streaming span's finalizer with the active recorder (two-phase, model (b))."""
    sink = _active_open_sink.get()
    if sink is not None:
        sink.register_open_span(span_id, finalize)


def unregister_open_span(span_id: str) -> None:
    sink = _active_open_sink.get()
    if sink is not None:
        sink.unregister_open_span(span_id)


def set_active_recorder(cb: Callable[[dict], Any], sink: Any = None):
    """Make `cb` the active intercepted-span handler (and `sink` the open-span recorder) for the
    current context. Returns a token for reset_active_recorder."""
    t1 = _active_recorder_cb.set(cb)
    t2 = _active_open_sink.set(sink) if sink is not None else None
    return (t1, t2)


def reset_active_recorder(token) -> None:
    try:
        if isinstance(token, tuple):
            t1, t2 = token
            _active_recorder_cb.reset(t1)
            if t2 is not None:
                _active_open_sink.reset(t2)
        else:
            _active_recorder_cb.reset(token)  # backward-compat (older single-token callers)
    except Exception:
        pass
