"""Comprehensive test suite for retrace Python SDK."""
import json
import os
from unittest.mock import patch, MagicMock
import pytest

import retrace.config as cfg


@pytest.fixture(autouse=True)
def reset_config():
    cfg._config = None
    os.environ.pop("RETRACE_API_KEY", None)
    os.environ.pop("RETRACE_BASE_URL", None)
    os.environ.pop("RETRACE_ENABLED", None)
    os.environ.pop("RETRACE_PROJECT_ID", None)
    yield
    cfg._config = None


class TestConfig:
    def test_defaults(self):
        c = cfg.get_config()
        assert c.base_url == "http://localhost:3001"
        assert c.ws_url == "ws://localhost:3001"
        assert c.enabled is True
        assert c.api_key == ""
        assert c.project_id is None

    def test_env_vars(self):
        os.environ["RETRACE_API_KEY"] = "rt_live_env"
        os.environ["RETRACE_BASE_URL"] = "https://api.example.com"
        os.environ["RETRACE_PROJECT_ID"] = "proj-123"
        c = cfg.get_config()
        assert c.api_key == "rt_live_env"
        assert c.base_url == "https://api.example.com"
        assert c.ws_url == "wss://api.example.com"
        assert c.project_id == "proj-123"

    def test_disable_via_env(self):
        for val in ("false", "0", "no"):
            cfg._config = None
            os.environ["RETRACE_ENABLED"] = val
            assert cfg.get_config().enabled is False

    def test_configure_override(self):
        cfg.configure(api_key="rt_live_x", base_url="https://c.io")
        c = cfg.get_config()
        assert c.api_key == "rt_live_x"
        assert c.ws_url == "wss://c.io"

    def test_configure_updates_ws_url(self):
        cfg.configure(base_url="https://new.io")
        assert cfg.get_config().ws_url == "wss://new.io"


class TestTraceModel:
    def test_span_serialization(self):
        from retrace import Span, SpanType
        s = Span(name="test", span_type=SpanType.LLM_CALL, model="gpt-4o",
                 input={"prompt": "hi"}, output="hello", input_tokens=5,
                 output_tokens=3, cost=0.001)
        d = s.to_dict()
        assert d["name"] == "test"
        assert d["span_type"] == "llm_call"
        assert d["model"] == "gpt-4o"
        assert d["cost"] == 0.001
        assert len(d["id"]) == 36
        assert d["started_at"].endswith("Z")
        json.dumps(d)  # must be serializable

    def test_span_excludes_none(self):
        from retrace import Span, SpanType
        s = Span(name="x", span_type=SpanType.TOOL_CALL)
        d = s.to_dict()
        assert "input" not in d
        assert "output" not in d
        assert "model" not in d
        assert "cost" not in d

    def test_trace_serialization(self):
        from retrace import Trace, Span, SpanType
        t = Trace(name="t", input="hi")
        t.spans.append(Span(name="s", span_type=SpanType.LLM_CALL))
        d = t.to_dict()
        assert d["name"] == "t"
        assert d["status"] == "running"
        assert len(d["spans"]) == 1
        json.dumps(d)

    def test_span_types(self):
        from retrace import SpanType
        assert SpanType.LLM_CALL.value == "llm_call"
        assert SpanType.TOOL_CALL.value == "tool_call"
        assert SpanType.TOOL_RESULT.value == "tool_result"
        assert SpanType.REASONING.value == "reasoning"
        assert SpanType.ERROR.value == "error"
        assert SpanType.FORK_POINT.value == "fork_point"

    def test_trace_status(self):
        from retrace import TraceStatus
        assert TraceStatus.RUNNING.value == "running"
        assert TraceStatus.COMPLETED.value == "completed"
        assert TraceStatus.FAILED.value == "failed"

    def test_large_input(self):
        from retrace import Span, SpanType
        big = "x" * 100000
        s = Span(name="big", span_type=SpanType.LLM_CALL, input=big)
        assert len(s.to_dict()["input"]) == 100000


class TestRecorder:
    @patch("retrace.recorder.create_transport")
    def test_decorator(self, mt):
        m = MagicMock(); mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import record

        @record(name="agent")
        def f(x): return x * 2

        assert f(3) == 6
        evts = [c[0][0] for c in m.send.call_args_list]
        assert "trace_started" in evts
        assert "trace_ended" in evts

    @patch("retrace.recorder.create_transport")
    def test_decorator_no_parens(self, mt):
        m = MagicMock(); mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import record

        @record
        def f(): return "ok"

        assert f() == "ok"

    @patch("retrace.recorder.create_transport")
    def test_context_manager(self, mt):
        m = MagicMock(); mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import record

        with record(name="ctx", input="in") as t:
            t.output = "out"

        ended = [c for c in m.send.call_args_list if c[0][0] == "trace_ended"][0]
        assert ended[0][1]["status"] == "completed"

    @patch("retrace.recorder.create_transport")
    def test_exception_marks_failed(self, mt):
        m = MagicMock(); mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import record

        @record(name="bad")
        def bad(): raise ValueError("oops")

        with pytest.raises(ValueError):
            bad()

        ended = [c for c in m.send.call_args_list if c[0][0] == "trace_ended"][0]
        assert ended[0][1]["status"] == "failed"

    @patch("retrace.recorder.create_transport")
    def test_network_failure_doesnt_crash(self, mt):
        m = MagicMock(); m.send.side_effect = ConnectionError("down")
        mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import record

        @record(name="net")
        def f(): return "ok"

        assert f() == "ok"

    def test_disabled_is_noop(self):
        cfg.configure(api_key="rt_live_t", enabled=False)
        from retrace import record

        @record(name="off")
        def f(): return 42

        assert f() == 42

    @patch("retrace.recorder.create_transport")
    def test_span_tracking(self, mt):
        m = MagicMock(); mt.return_value = m
        cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)
        from retrace import TraceRecorder, SpanType

        rec = TraceRecorder(name="test")
        rec.start_trace()
        span = rec.start_span("call-llm", SpanType.LLM_CALL, input="hi", model="gpt-4o")
        rec.end_span(span.id, output="hello")
        rec.end_trace(output="done")

        evts = [c[0][0] for c in m.send.call_args_list]
        assert evts == ["trace_started", "span_started", "span_ended", "trace_ended"]


class TestTransport:
    def test_http_accumulate_and_flush(self):
        from retrace.transport import HTTPTransport
        cfg.configure(api_key="rt_live_t", base_url="http://x:1")

        with patch("retrace.transport.requests.post", return_value=MagicMock(status_code=200)) as mp:
            http = HTTPTransport()
            http.send("trace_started", {"id": "abc", "name": "t", "status": "running",
                                         "started_at": "2026-01-01T00:00:00Z",
                                         "total_tokens": 0, "total_cost": 0, "total_duration_ms": 0})
            http.send("span_started", {"id": "s1", "trace_id": "abc", "span_type": "llm_call",
                                        "name": "s", "started_at": "2026-01-01T00:00:00Z"})
            http.send("span_ended", {"id": "s1", "ended_at": "2026-01-01T00:00:01Z", "output": "hi"})
            http.send("trace_ended", {"id": "abc", "ended_at": "2026-01-01T00:00:02Z", "status": "completed"})
            assert mp.called
            body = mp.call_args[1]["json"]
            assert body["id"] == "abc"
            assert len(body["spans"]) == 1
            assert body["spans"][0]["output"] == "hi"

    def test_http_flush_on_close(self):
        from retrace.transport import HTTPTransport
        cfg.configure(api_key="rt_live_t", base_url="http://x:1")

        with patch("retrace.transport.requests.post", return_value=MagicMock(status_code=200)) as mp:
            http = HTTPTransport()
            http.send("trace_started", {"id": "x", "status": "running", "started_at": "2026-01-01T00:00:00Z",
                                         "total_tokens": 0, "total_cost": 0, "total_duration_ms": 0})
            http.close()
            assert mp.called

    def test_create_transport_http(self):
        from retrace.transport import create_transport, HTTPTransport
        assert isinstance(create_transport("http"), HTTPTransport)

    def test_create_transport_ws_type(self):
        from retrace.transport import WSTransport
        ws = WSTransport()
        assert ws._connected is False
        ws.close()


class TestReadmeExamples:
    def test_python_readme(self):
        cfg.configure(api_key="rt_live_t", enabled=False)
        import retrace

        @retrace.record(name="my-agent")
        def run_agent(prompt: str):
            return f"Answer to: {prompt}"

        result = run_agent("What is quantum computing?")
        assert "quantum" in result
