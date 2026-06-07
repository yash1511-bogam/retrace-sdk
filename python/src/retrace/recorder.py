from __future__ import annotations

import functools
import inspect
import logging
import os
import random
import threading
from typing import Any, Callable

from .config import get_config, require_api_key
from .trace import Span, SpanType, Trace, TraceStatus
from .transport import HTTPTransport, WSTransport, create_transport
from .utils import utcnow

logger = logging.getLogger("retrace")


def _should_sample(rate: float, seed: str | None = None, key: str | None = None) -> bool:
    """Deterministic sampling using FNV-1a hash when seed is provided."""
    if rate >= 1.0:
        return True
    if rate <= 0.0:
        return False
    if not seed:
        return random.random() < rate
    # FNV-1a hash for deterministic decision
    input_str = f"{seed}:{key or ''}"
    h = 2166136261
    for ch in input_str:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return (h / 4294967296.0) < rate


# Shared transport — stays open across multiple traces for resume/replay listening
_shared_transport: WSTransport | HTTPTransport | None = None
_shared_lock = threading.Lock()

# Pre-exit hooks run BEFORE the transport drains on the SIGTERM path — e.g. the ambient trace
# finishing itself (emitting a terminated_early trace_ended) so it's in the buffer for the flush.
_pre_exit_hooks: list = []
_installed_sigterm_handler = None


def on_process_exit(fn):
    """Register a callable(reason: str) run on the SIGTERM exit path before the transport drains."""
    _pre_exit_hooks.append(fn)


def _run_pre_exit_hooks(reason: str):
    for h in list(_pre_exit_hooks):
        try:
            h(reason)
        except Exception:
            pass


def _get_shared_transport() -> WSTransport | HTTPTransport:
    global _shared_transport
    with _shared_lock:
        if _shared_transport is None:
            _shared_transport = create_transport(get_config().transport)
            cfg = get_config()
            # Guard A: only register the network exit hook when actually configured — an
            # imported-but-unconfigured SDK installs no atexit handler and makes no exit-time call.
            if cfg.enabled and cfg.api_key:
                import atexit
                atexit.register(_flush_on_exit)
                _install_sigterm_handler()
            # Fork awareness: gunicorn/uvicorn pre-fork is the dominant Python deploy. A child
            # inherits the parent's buffered events + dead worker/socket refs; without this it could
            # re-emit the parent's buffer. Clear the child's transport state right after fork.
            if hasattr(os, "register_at_fork"):
                os.register_at_fork(after_in_child=_reset_transport_in_child)
        return _shared_transport


def _install_sigterm_handler():
    """Flush the buffer on SIGTERM (docker stop / k8s pod termination) — atexit does NOT run on
    SIGTERM, so a containerized job would otherwise silently lose its buffered trace.

    Sole-owner + main-thread gate (the exact analog of TS's listenerCount('SIGTERM') === 0): install
    ONLY if SIGTERM is still SIG_DFL (no framework owns it) and we're on the main thread (signal.signal
    off the main thread raises ValueError). If gunicorn/uvicorn/celery already installed a SIGTERM
    handler, getsignal != SIG_DFL → we skip and never clobber their graceful shutdown. We chain by
    restoring SIG_DFL and re-raising, so the process still terminates with normal SIGTERM semantics.
    SIGINT is intentionally left to atexit — seizing Ctrl-C/KeyboardInterrupt is the surprising case.
    """
    import signal
    if threading.current_thread() is not threading.main_thread():
        return
    try:
        if signal.getsignal(signal.SIGTERM) is not signal.SIG_DFL:
            return  # a framework (or the user) owns SIGTERM — stay a guest, don't clobber

        def _sigterm_handler(signum, frame):
            _run_pre_exit_hooks("signal")  # finish ambient trace (terminated_early) into the buffer
            _flush_on_exit()               # drain the bounded buffer (Guard B: no-op if empty)
            # Exit 143 (128+SIGTERM) directly rather than restoring SIG_DFL + re-raising: under a
            # container the SDK is often PID 1, and Linux IGNORES SIG_DFL signals for PID 1 — a
            # re-raise would hang. os._exit is immediate and PID-1-safe (we only install this when
            # SIGTERM was SIG_DFL, so there is no prior handler to chain to).
            os._exit(143)

        signal.signal(signal.SIGTERM, _sigterm_handler)
        global _installed_sigterm_handler
        _installed_sigterm_handler = _sigterm_handler
    except (ValueError, OSError):
        pass  # not main thread / not permitted — never crash the user's import


def _reset_transport_in_child():
    if _shared_transport is not None and hasattr(_shared_transport, "reset_for_child"):
        try:
            _shared_transport.reset_for_child()
        except Exception:
            pass
    # Belt-and-suspenders: drop the SIGTERM handler we installed in the parent so a raw os.fork /
    # multiprocessing child never carries the master's handler (which would finalize the master's
    # ambient trace from the child). gunicorn/uvicorn re-establish their own signals in the worker
    # post-fork anyway; this just covers the no-framework case.
    if _installed_sigterm_handler is not None:
        try:
            import signal
            if signal.getsignal(signal.SIGTERM) is _installed_sigterm_handler:
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
        except (ValueError, OSError):
            pass


def _flush_on_exit():
    """Flush any pending data before process exits (no-op when nothing is pending — Guard B)."""
    t = _shared_transport
    if t is None:
        return
    # Guard B: zero-event run → nothing to drain, no exit-time network call.
    if hasattr(t, "has_pending_data") and not t.has_pending_data():
        return
    try:
        t.close()
    except Exception:
        pass


class TraceRecorder:
    """Manages recording of a single trace and its spans."""

    def __init__(
        self, name: str | None = None, input: Any = None, metadata: dict | None = None,
        resumable: bool = False, session_id: str | None = None, fork_point_span_id: str | None = None,
        fork_point_index: int | None = None,
    ):
        require_api_key()
        self._trace = Trace(
            name=name,
            input=input,
            metadata=metadata or {},
            project_id=get_config().project_id,
            session_id=session_id,
        )
        if resumable:
            self._trace.metadata["_resumable"] = True
        self._lock = threading.Lock()
        self._transport = _get_shared_transport()
        self._interceptors_installed = False
        # Fork point filtering: suppress pre-fork spans during cascade replay.
        # Server copies pre-fork spans; SDK only emits from fork point onward.
        self._fork_point_span_id = fork_point_span_id
        # 0-based ordinal of the fork-point span in the original trace. Cascade replay re-executes the
        # whole function with NEW span ids, so suppression of pre-fork spans must be positional: emit
        # only from this index onward. None => no suppression (emit everything).
        self._fork_point_index = fork_point_index
        self._fork_point_reached = fork_point_span_id is None or fork_point_index is None
        self._span_counter = 0
        self._cv_token = None
        self._tp_token = None
        self._open_spans = {}  # span_id -> finalize(reason) for two-phase streaming spans

    @property
    def trace(self) -> Trace:
        return self._trace

    @property
    def output(self):
        return self._trace.output

    @output.setter
    def output(self, value):
        self._trace.output = value

    def _install_interceptors(self):
        if self._interceptors_installed:
            return
        # Install ONE stable dispatcher; the active recorder is resolved per-context (see
        # interceptors/_dispatch.py) so concurrent traces don't cross-route spans.
        from .interceptors._dispatch import dispatch_intercepted_span
        try:
            from .interceptors.gemini import install_gemini_interceptor
            install_gemini_interceptor(dispatch_intercepted_span)
        except Exception as e:
            logger.debug(f"Failed to install Gemini interceptor: {e}")
        try:
            from .interceptors.openai import install_openai_interceptor
            install_openai_interceptor(dispatch_intercepted_span)
        except Exception as e:
            logger.debug(f"Failed to install OpenAI interceptor: {e}")
        try:
            from .interceptors.anthropic import install_anthropic_interceptor
            install_anthropic_interceptor(dispatch_intercepted_span)
        except Exception as e:
            logger.debug(f"Failed to install Anthropic interceptor: {e}")
        self._interceptors_installed = True

    def _handle_intercepted_span(self, span_data: dict):
        span = Span(
            trace_id=self._trace.id,
            span_type=SpanType(span_data.get("span_type", "llm_call")),
            name=span_data.get("name", ""),
            parent_id=span_data.get("parent_id"),
            model=span_data.get("model"),
            input=span_data.get("input"),
            output=span_data.get("output"),
            input_tokens=span_data.get("input_tokens"),
            output_tokens=span_data.get("output_tokens"),
            cost=span_data.get("cost"),
            duration_ms=span_data.get("duration_ms"),
            metadata=span_data.get("metadata") or {},
            error=span_data.get("error"),
        )
        if span_data.get("id"):
            span.id = span_data["id"]
        span.ended_at = utcnow()
        self.add_span(span)

    def start_trace(self, name: str | None = None, input: Any = None, metadata: dict | None = None):
        if name:
            self._trace.name = name
        if input is not None:
            self._trace.input = input
        if metadata:
            self._trace.metadata.update(metadata)
        self._install_interceptors()
        # Route auto-instrumented spans to THIS recorder for the current context only.
        from .interceptors._dispatch import set_active_recorder
        self._cv_token = set_active_recorder(self._handle_intercepted_span, self)
        # Propagate W3C trace context for outbound HTTP calls made during the trace.
        from .traceparent import set_trace_context
        self._tp_token = set_trace_context(self._trace.id, self._trace.id)
        self._send("trace_started", self._trace.to_dict())

    def register_open_span(self, span_id, finalize):
        """Two-phase streaming spans: register an open span's finalizer (model (b))."""
        self._open_spans[span_id] = finalize

    def unregister_open_span(self, span_id):
        self._open_spans.pop(span_id, None)

    def _finalize_open_spans(self):
        """Close any still-open streaming spans as partial (capture_complete=False) — a stream that
        was abandoned mid-drain (or never reached a clean end) is emitted into the trace, flagged
        not-byte-replayable, rather than lost."""
        if not self._open_spans:
            return
        for finalize in list(self._open_spans.values()):
            try:
                finalize("partial")
            except Exception:
                pass
        self._open_spans.clear()

    def end_trace(self, output: Any = None, status: TraceStatus = TraceStatus.COMPLETED, terminated_early: bool = False):
        # Close dangling streaming spans BEFORE the terminal event so they land in this trace.
        self._finalize_open_spans()
        self._trace.output = output if output is not None else self._trace.output
        self._trace.status = status
        self._trace.ended_at = utcnow()
        if self._trace.started_at:
            self._trace.total_duration_ms = int(
                (self._trace.ended_at - self._trace.started_at).total_seconds() * 1000
            )
        trace_ended_payload = {
            "id": self._trace.id,
            "ended_at": self._trace.ended_at.isoformat().replace("+00:00", "Z"),
            "output": self._trace.output,
            "status": status.value,
            "total_tokens": self._trace.total_tokens,
            "total_cost": self._trace.total_cost,
        }
        # Force-closed by exit/interrupted finalization: a synthesized terminal must NOT look clean
        # to the replay-guard. terminated_early ⇒ refuse byte-deterministic replay (same as
        # no-terminal / lossy / capture_complete:false). Only a naturally-finished run is clean.
        if terminated_early:
            trace_ended_payload["terminated_early"] = True
        self._send("trace_ended", trace_ended_payload)
        # HTTP fallback (best-effort): snapshot the payload on THIS thread first, then PATCH off-thread
        # so a slow round-trip never blocks the traced function's return AND the background thread
        # never reads self._trace while another thread mutates it. WS already delivered trace_ended.
        flush_payload = {
            "status": self._trace.status.value,
            "output": self._trace.output,
            "ended_at": self._trace.ended_at.isoformat().replace("+00:00", "Z") if self._trace.ended_at else None,
            "total_tokens": self._trace.total_tokens,
            "total_cost": self._trace.total_cost,
            "total_duration_ms": self._trace.total_duration_ms,
        }
        if terminated_early:
            flush_payload["terminated_early"] = True
        threading.Thread(target=self._http_flush, args=(self._trace.id, flush_payload), daemon=True, name="retrace-http-flush").start()
        # Release this context's active-recorder binding (restores any enclosing trace).
        if self._cv_token is not None:
            from .interceptors._dispatch import reset_active_recorder
            reset_active_recorder(self._cv_token)
            self._cv_token = None
        # Restore the enclosing trace context (or clear it).
        if self._tp_token is not None:
            from .traceparent import clear_trace_context
            clear_trace_context(self._tp_token)
            self._tp_token = None

    def add_span(self, span: Span):
        self._span_counter += 1
        # Fork-point filtering: during cascade replay, suppress the pre-fork spans (the server already
        # has them / they replay from the cassette) and emit only from the fork point onward. The
        # fork point is the (fork_point_index)-th span (0-based), i.e. the (index+1)-th emitted here,
        # so suppress while span_counter <= index and emit once we reach it. (Previously this compared
        # span_counter >= 1, which is always true after the increment => zero suppression / no-op.)
        if not self._fork_point_reached:
            if self._fork_point_index is not None and self._span_counter > self._fork_point_index:
                self._fork_point_reached = True
            else:
                return  # Suppress pre-fork span

        span.trace_id = self._trace.id
        with self._lock:
            self._trace.spans.append(span)
            self._trace.total_tokens += (span.input_tokens or 0) + (span.output_tokens or 0)
            self._trace.total_cost += span.cost or 0.0

        if span.ended_at:
            # Span is complete — send both started and ended
            self._send("span_started", span.to_dict())
            ended = {
                "id": span.id,
                "ended_at": span.ended_at.isoformat().replace("+00:00", "Z"),
                "output": span.output,
                "output_tokens": span.output_tokens,
                "cost": span.cost,
            }
            if span.error:
                ended["error"] = span.error
            self._send("span_ended", ended)
        else:
            self._send("span_started", span.to_dict())

    def start_span(
        self,
        name: str,
        span_type: SpanType = SpanType.LLM_CALL,
        input: Any = None,
        model: str | None = None,
        parent_id: str | None = None,
    ) -> Span:
        span = Span(
            trace_id=self._trace.id,
            span_type=span_type,
            name=name,
            input=input,
            model=model,
            parent_id=parent_id,
        )
        with self._lock:
            self._trace.spans.append(span)
        self._send("span_started", span.to_dict())
        return span

    def end_span(self, span_id: str, output: Any = None, error: str | None = None):
        with self._lock:
            span = next((s for s in self._trace.spans if s.id == span_id), None)
        if not span:
            return
        span.output = output
        span.error = error
        span.ended_at = utcnow()
        if span.started_at:
            span.duration_ms = int((span.ended_at - span.started_at).total_seconds() * 1000)
        ended = {
            "id": span.id,
            "ended_at": span.ended_at.isoformat().replace("+00:00", "Z"),
            "output": output,
        }
        if error:
            ended["error"] = error
        self._send("span_ended", ended)

    def _send(self, event_type: str, data: dict):
        try:
            self._transport.send(event_type, data)
        except Exception as e:
            logger.debug(f"Failed to send {event_type}: {e}")

    def _http_flush(self, trace_id: str, payload: dict):
        """Send trace_ended via HTTP PATCH as a reliable fallback when WS may drop messages.
        Receives a pre-snapshotted payload so it never reads self._trace off-thread."""
        try:
            import requests as _req
            cfg = get_config()
            url = f"{cfg.base_url}/api/v1/traces/{trace_id}"
            headers = {"x-retrace-key": cfg.api_key, "Content-Type": "application/json"}
            _req.patch(url, json=payload, headers=headers, timeout=5)
        except Exception as e:
            logger.debug(f"HTTP flush failed: {e}")

    # Context manager support
    def __enter__(self):
        self.start_trace()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self.end_trace(status=TraceStatus.FAILED)
        else:
            self.end_trace(status=TraceStatus.COMPLETED)
        return False


def record(
    name: str | None = None, input: Any = None, metadata: dict | None = None,
    resumable: bool = False, session_id: str | None = None,
):
    """Decorator and context manager for recording agent executions.

    Usage as decorator:
        @retrace.record(name="my-agent")
        def my_agent(prompt):
            ...

        @retrace.record(name="my-agent", resumable=True)
        def my_agent(prompt):
            ...  # Supports fork-and-replay from any span

    Usage as context manager:
        with retrace.record(name="my-agent", input={"prompt": "hi"}) as t:
            result = agent.run("hi")
            t.output = result
    """
    cfg = get_config()

    # If called with a function directly: @record without parens
    if callable(name):
        fn = name
        if not cfg.enabled:
            return fn

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not _should_sample(cfg.sample_rate, cfg.sample_seed, fn.__name__):
                return fn(*args, **kwargs)
            recorder = TraceRecorder(
                name=fn.__name__, input={"args": list(args), "kwargs": kwargs}, resumable=resumable
            )
            recorder.start_trace()
            try:
                result = fn(*args, **kwargs)
                recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
                return result
            except Exception:
                recorder.end_trace(status=TraceStatus.FAILED)
                raise

        return wrapper

    # Called with arguments: @record(name="...") or as context manager
    def decorator(fn: Callable | None = None):
        if fn is None:
            # Context manager usage
            return TraceRecorder(name=name, input=input, metadata=metadata, resumable=resumable)

        if not cfg.enabled:
            return fn

        # Register for cascade replay if resumable
        if resumable:
            from .resume import register_resumable
            register_resumable(name or fn.__name__, fn)

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if not _should_sample(cfg.sample_rate, cfg.sample_seed, name or fn.__name__):
                return fn(*args, **kwargs)
            recorder = TraceRecorder(
                name=name or fn.__name__,
                input=input if input is not None else {"args": list(args), "kwargs": kwargs},
                metadata=metadata,
                session_id=session_id or kwargs.get("session_id"),
            )
            recorder.start_trace()
            try:
                result = fn(*args, **kwargs)
                recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
                return result
            except Exception:
                recorder.end_trace(status=TraceStatus.FAILED)
                raise

        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            if not _should_sample(cfg.sample_rate, cfg.sample_seed, name or fn.__name__):
                return await fn(*args, **kwargs)
            recorder = TraceRecorder(
                name=name or fn.__name__,
                input=input if input is not None else {"args": list(args), "kwargs": kwargs},
                metadata=metadata,
                session_id=session_id or kwargs.get("session_id"),
            )
            recorder.start_trace()
            try:
                result = await fn(*args, **kwargs)
                recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
                return result
            except Exception:
                recorder.end_trace(status=TraceStatus.FAILED)
                raise

        return async_wrapper if inspect.iscoroutinefunction(fn) else wrapper

    # If no function passed, could be context manager or decorator
    if not cfg.enabled:
        # Return a no-op context manager
        class _NoOp:
            output = None
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def __call__(self, fn): return fn
        return _NoOp()

    # Return something that works as both decorator and context manager
    class _RecordProxy:
        def __init__(self):
            self._recorder = TraceRecorder(name=name, input=input, metadata=metadata, resumable=resumable)
            self._sampled = _should_sample(cfg.sample_rate, cfg.sample_seed, name)

        @property
        def output(self):
            return self._recorder.output

        @output.setter
        def output(self, value):
            self._recorder.output = value

        def __call__(self, fn):
            return decorator(fn)

        def __enter__(self):
            if not self._sampled:
                return self
            self._recorder.start_trace()
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            if not self._sampled:
                return False
            if exc_type:
                self._recorder.end_trace(status=TraceStatus.FAILED)
            else:
                self._recorder.end_trace(status=TraceStatus.COMPLETED)
            return False

    return _RecordProxy()
