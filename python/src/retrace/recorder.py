from __future__ import annotations

import functools
import logging
import random
import threading
import time
from typing import Any, Callable

logger = logging.getLogger("retrace")

from .config import get_config, require_api_key
from .trace import Trace, Span, SpanType, TraceStatus
from .transport import create_transport, WSTransport, HTTPTransport
from .utils import gen_id, utcnow


class TraceRecorder:
    """Manages recording of a single trace and its spans."""

    def __init__(self, name: str | None = None, input: Any = None, metadata: dict | None = None, resumable: bool = False):
        require_api_key()
        self._trace = Trace(
            name=name,
            input=input,
            metadata=metadata or {},
            project_id=get_config().project_id,
        )
        if resumable:
            self._trace.metadata["_resumable"] = True
        self._lock = threading.Lock()
        self._transport = create_transport()
        self._interceptors_installed = False

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
        try:
            from .interceptors.gemini import install_gemini_interceptor
            install_gemini_interceptor(lambda span_data: self._handle_intercepted_span(span_data))
        except Exception as e:
            logger.debug(f"Failed to install Gemini interceptor: {e}")
        try:
            from .interceptors.openai import install_openai_interceptor
            install_openai_interceptor(lambda span_data: self._handle_intercepted_span(span_data))
        except Exception as e:
            logger.debug(f"Failed to install OpenAI interceptor: {e}")
        try:
            from .interceptors.anthropic import install_anthropic_interceptor
            install_anthropic_interceptor(lambda span_data: self._handle_intercepted_span(span_data))
        except Exception as e:
            logger.debug(f"Failed to install Anthropic interceptor: {e}")
        self._interceptors_installed = True

    def _handle_intercepted_span(self, span_data: dict):
        span = Span(
            trace_id=self._trace.id,
            span_type=SpanType(span_data.get("span_type", "llm_call")),
            name=span_data.get("name", ""),
            model=span_data.get("model"),
            input=span_data.get("input"),
            output=span_data.get("output"),
            input_tokens=span_data.get("input_tokens"),
            output_tokens=span_data.get("output_tokens"),
            cost=span_data.get("cost"),
            duration_ms=span_data.get("duration_ms"),
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
        self._send("trace_started", self._trace.to_dict())

    def end_trace(self, output: Any = None, status: TraceStatus = TraceStatus.COMPLETED):
        self._trace.output = output if output is not None else self._trace.output
        self._trace.status = status
        self._trace.ended_at = utcnow()
        if self._trace.started_at:
            self._trace.total_duration_ms = int(
                (self._trace.ended_at - self._trace.started_at).total_seconds() * 1000
            )
        self._send("trace_ended", {
            "id": self._trace.id,
            "ended_at": self._trace.ended_at.isoformat().replace("+00:00", "Z"),
            "output": self._trace.output,
            "status": status.value,
            "total_tokens": self._trace.total_tokens,
            "total_cost": self._trace.total_cost,
        })
        self._transport.close()

    def add_span(self, span: Span):
        span.trace_id = self._trace.id
        with self._lock:
            self._trace.spans.append(span)
            self._trace.total_tokens += (span.input_tokens or 0) + (span.output_tokens or 0)
            self._trace.total_cost += span.cost or 0.0

        if span.ended_at:
            # Span is complete — send both started and ended
            self._send("span_started", span.to_dict())
            self._send("span_ended", {
                "id": span.id,
                "ended_at": span.ended_at.isoformat().replace("+00:00", "Z"),
                "output": span.output,
                "output_tokens": span.output_tokens,
                "cost": span.cost,
                "error": span.error,
            })
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
        self._send("span_ended", {
            "id": span.id,
            "ended_at": span.ended_at.isoformat().replace("+00:00", "Z"),
            "output": output,
            "error": error,
        })

    def _send(self, event_type: str, data: dict):
        try:
            self._transport.send(event_type, data)
        except Exception as e:
            logger.debug(f"Failed to send {event_type}: {e}")

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


def record(name: str | None = None, input: Any = None, metadata: dict | None = None, resumable: bool = False):
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
            if random.random() > cfg.sample_rate:
                return fn(*args, **kwargs)
            recorder = TraceRecorder(name=fn.__name__, input={"args": list(args), "kwargs": kwargs}, resumable=resumable)
            recorder.start_trace()
            try:
                result = fn(*args, **kwargs)
                recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
                return result
            except Exception as e:
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
            if random.random() > cfg.sample_rate:
                return fn(*args, **kwargs)
            recorder = TraceRecorder(
                name=name or fn.__name__,
                input=input if input is not None else {"args": list(args), "kwargs": kwargs},
                metadata=metadata,
            )
            recorder.start_trace()
            try:
                result = fn(*args, **kwargs)
                recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
                return result
            except Exception as e:
                recorder.end_trace(status=TraceStatus.FAILED)
                raise

        return wrapper

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
            self._sampled = random.random() <= cfg.sample_rate

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
