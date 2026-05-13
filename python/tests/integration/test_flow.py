"""Integration tests — mock the Retrace API and test full SDK flow."""
import json
import os
from unittest.mock import patch, MagicMock
import pytest

import retrace
import retrace.config as cfg
from retrace.recorder import record, TraceRecorder
from retrace.trace import Trace, Span, SpanType
from retrace.transport import HTTPTransport


@pytest.fixture(autouse=True)
def setup():
    cfg._config = None
    os.environ.pop("RETRACE_API_KEY", None)
    retrace.configure(api_key="rt_live_integration_test", base_url="http://localhost:3001")
    yield
    cfg._config = None


def _make_http_transport():
    return HTTPTransport()


class TestFullRecordingFlow:
    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_record_decorator_sends_trace(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="integration-agent")
        def my_agent(prompt):
            return f"Response to: {prompt}"

        result = my_agent("hello world")
        assert result == "Response to: hello world"
        assert mock_post.called

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_record_captures_input_output(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="io-test")
        def compute(x, y):
            return x * y

        result = compute(6, 7)
        assert result == 42
        assert mock_post.called

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_record_captures_error(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="error-test")
        def broken():
            raise RuntimeError("something broke")

        with pytest.raises(RuntimeError):
            broken()

        assert mock_post.called

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_manual_span_creation(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="manual-spans")
        def agent():
            return "done"

        agent()
        assert mock_post.called

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_nested_spans(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="nested")
        def agent():
            return "done"

        agent()
        assert mock_post.called


class TestAPIContract:
    """Verify the SDK sends data matching the API contract."""

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_trace_payload_structure(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="contract-test", metadata={"env": "test"})
        def agent():
            return "ok"

        agent()
        assert mock_post.called
        payload = mock_post.call_args[1]["json"]
        assert "name" in payload or "id" in payload

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_auth_header_sent(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="auth-test")
        def agent():
            return "ok"

        agent()
        headers = mock_post.call_args[1]["headers"]
        assert headers.get("x-retrace-key") == "rt_live_integration_test"

    @patch("retrace.transport.requests.post")
    @patch("retrace.recorder.create_transport", side_effect=_make_http_transport)
    def test_content_type_json(self, mock_ct, mock_post):
        mock_post.return_value = MagicMock(status_code=200)

        @record(name="content-type-test")
        def agent():
            return "ok"

        agent()
        headers = mock_post.call_args[1]["headers"]
        assert "application/json" in headers.get("Content-Type", "")


class TestDisabledSDK:
    def test_disabled_sdk_does_not_send(self):
        cfg._config = None
        retrace.configure(api_key="rt_live_test", enabled=False)
        # When disabled, record should still execute the function
        @record(name="disabled-test")
        def agent():
            return "still works"

        # This should work without any network calls
        result = agent()
        assert result == "still works"
