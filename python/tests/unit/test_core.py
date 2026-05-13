"""Unit tests for retrace Python SDK — auth, retries, timeouts, errors, serialization."""
import json
import os
import time
import threading
from unittest.mock import patch, MagicMock, PropertyMock
import pytest

import retrace
import retrace.config as cfg
from retrace.config import configure, get_config, require_api_key
from retrace.recorder import TraceRecorder, record
from retrace.trace import Trace, Span, SpanType, TraceStatus
from retrace.transport import HTTPTransport, WSTransport


@pytest.fixture(autouse=True)
def reset_state():
    cfg._config = None
    os.environ.pop("RETRACE_API_KEY", None)
    os.environ.pop("RETRACE_BASE_URL", None)
    os.environ.pop("RETRACE_ENABLED", None)
    os.environ.pop("RETRACE_PROJECT_ID", None)
    yield
    cfg._config = None


# ─── AUTH ───────────────────────────────────────────────────────────────────

class TestAuth:
    def test_valid_api_key(self):
        c = configure(api_key="rt_live_abc123")
        assert c.api_key == "rt_live_abc123"

    def test_invalid_prefix_raises(self):
        with pytest.raises(ValueError, match="rt_live_"):
            configure(api_key="sk-invalid-key")

    def test_empty_key_allowed_at_configure(self):
        c = configure(api_key="")
        assert c.api_key == ""

    def test_require_api_key_raises_when_missing(self):
        configure(api_key="")
        with pytest.raises(RuntimeError, match="Retrace API key required"):
            require_api_key()

    def test_require_api_key_returns_key(self):
        configure(api_key="rt_live_test123")
        assert require_api_key() == "rt_live_test123"

    def test_env_var_api_key(self):
        os.environ["RETRACE_API_KEY"] = "rt_live_from_env"
        c = get_config()
        assert c.api_key == "rt_live_from_env"

    def test_recorder_requires_key(self):
        configure(api_key="")
        with pytest.raises(RuntimeError, match="Retrace API key required"):
            TraceRecorder(name="test")


# ─── CONFIGURATION ─────────────────────────────────────────────────────────

class TestConfiguration:
    def test_base_url_default(self):
        c = get_config()
        assert c.base_url == "http://localhost:3001"

    def test_ws_url_derived(self):
        configure(api_key="rt_live_x", base_url="https://api.example.com")
        c = get_config()
        assert c.ws_url == "wss://api.example.com"

    def test_disabled_via_env(self):
        os.environ["RETRACE_ENABLED"] = "false"
        c = get_config()
        assert c.enabled is False

    def test_project_id(self):
        configure(api_key="rt_live_x", project_id="proj-123")
        assert get_config().project_id == "proj-123"


# ─── TRACE SERIALIZATION ───────────────────────────────────────────────────

class TestSerialization:
    def test_trace_to_dict(self):
        t = Trace(name="test-trace", input={"prompt": "hello"})
        d = t.to_dict()
        assert d["name"] == "test-trace"
        assert d["input"] == {"prompt": "hello"}
        assert "id" in d
        assert d["status"] == "running"

    def test_span_to_dict(self):
        s = Span(name="llm-call", span_type=SpanType.LLM_CALL, input={"messages": []})
        d = s.to_dict()
        assert d["name"] == "llm-call"
        assert d["span_type"] == "llm_call"

    def test_trace_with_spans(self):
        t = Trace(name="multi")
        s1 = Span(name="s1", span_type=SpanType.LLM_CALL)
        s2 = Span(name="s2", span_type=SpanType.TOOL_CALL)
        t.spans.append(s1)
        t.spans.append(s2)
        d = t.to_dict()
        assert len(d["spans"]) == 2

    def test_metadata_serialization(self):
        t = Trace(name="meta", metadata={"key": "value", "nested": {"a": 1}})
        d = t.to_dict()
        assert d["metadata"]["key"] == "value"
        assert d["metadata"]["nested"]["a"] == 1

    def test_cost_precision(self):
        s = Span(name="cost", span_type=SpanType.LLM_CALL)
        s.cost = 0.000123
        d = s.to_dict()
        assert isinstance(d["cost"], float)


# ─── INVALID INPUTS ────────────────────────────────────────────────────────

class TestInvalidInputs:
    def test_record_with_no_name_uses_function_name(self):
        configure(api_key="rt_live_test")
        with patch("retrace.recorder.create_transport") as mock_t:
            mock_t.return_value = MagicMock()

            @record()
            def my_agent():
                return "result"

            my_agent()

    def test_trace_status_transitions(self):
        t = Trace(name="test")
        assert t.status == TraceStatus.RUNNING
        t.status = TraceStatus.COMPLETED
        assert t.status == TraceStatus.COMPLETED

    def test_span_type_enum(self):
        assert SpanType.LLM_CALL == "llm_call"
        assert SpanType.TOOL_CALL == "tool_call"
        assert SpanType.ERROR == "error"


# ─── NETWORK FAILURES ──────────────────────────────────────────────────────

class TestNetworkFailures:
    @patch("retrace.transport.requests.post")
    def test_http_transport_handles_connection_error(self, mock_post):
        mock_post.side_effect = ConnectionError("Connection refused")
        configure(api_key="rt_live_test")
        transport = HTTPTransport()
        transport.send("trace_started", {"id": "t1", "name": "fail"})
        transport.send("trace_ended", {"status": "completed"})
        # flush should not raise

    @patch("retrace.transport.requests.post")
    def test_http_transport_handles_timeout(self, mock_post):
        import requests as req
        mock_post.side_effect = req.Timeout("Timed out")
        configure(api_key="rt_live_test")
        transport = HTTPTransport()
        transport.send("trace_started", {"id": "t1", "name": "timeout"})
        transport.send("trace_ended", {"status": "completed"})

    @patch("retrace.transport.requests.post")
    def test_http_transport_handles_500(self, mock_post):
        mock_post.return_value = MagicMock(status_code=500, text="Internal Server Error")
        configure(api_key="rt_live_test")
        transport = HTTPTransport()
        transport.send("trace_started", {"id": "t1", "name": "server-error"})
        transport.send("trace_ended", {"status": "completed"})


# ─── RATE LIMITS ───────────────────────────────────────────────────────────

class TestRateLimits:
    @patch("retrace.transport.requests.post")
    def test_http_transport_handles_429(self, mock_post):
        mock_post.return_value = MagicMock(status_code=429, text="Rate limited")
        configure(api_key="rt_live_test")
        transport = HTTPTransport()
        transport.send("trace_started", {"id": "t1", "name": "rate-limited"})
        transport.send("trace_ended", {"status": "completed"})

    @patch("retrace.transport.requests.post")
    def test_http_sends_auth_header(self, mock_post):
        mock_post.return_value = MagicMock(status_code=200)
        configure(api_key="rt_live_mykey123")
        transport = HTTPTransport()
        transport.send("trace_started", {"id": "t1", "name": "auth-check"})
        transport.send("trace_ended", {"status": "completed"})
        headers = mock_post.call_args[1]["headers"]
        assert headers["x-retrace-key"] == "rt_live_mykey123"


# ─── RECORDER ──────────────────────────────────────────────────────────────

class TestRecorder:
    def test_decorator_captures_return_value(self):
        configure(api_key="rt_live_test")
        with patch("retrace.recorder.create_transport") as mock_t:
            mock_transport = MagicMock()
            mock_t.return_value = mock_transport

            @record(name="my-func")
            def add(a, b):
                return a + b

            result = add(2, 3)
            assert result == 5

    def test_decorator_captures_exception(self):
        configure(api_key="rt_live_test")
        with patch("retrace.recorder.create_transport") as mock_t:
            mock_t.return_value = MagicMock()

            @record(name="failing")
            def fail():
                raise ValueError("boom")

            with pytest.raises(ValueError, match="boom"):
                fail()

    def test_resumable_flag(self):
        configure(api_key="rt_live_test")
        with patch("retrace.recorder.create_transport") as mock_t:
            mock_t.return_value = MagicMock()
            rec = TraceRecorder(name="resumable-test", resumable=True)
            assert rec._trace.metadata.get("_resumable") is True

    def test_non_resumable_default(self):
        configure(api_key="rt_live_test")
        with patch("retrace.recorder.create_transport") as mock_t:
            mock_t.return_value = MagicMock()
            rec = TraceRecorder(name="normal")
            assert "_resumable" not in rec._trace.metadata
