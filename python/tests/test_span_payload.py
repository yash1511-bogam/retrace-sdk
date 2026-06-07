"""Span payloads must never carry a null `error` field — the ingestion schema rejects
`error: null` with HTTP 400, which previously caused silent whole-trace loss on the HTTP
transport. A successful span must omit `error` entirely.
"""
from unittest.mock import MagicMock, patch

import retrace.config as cfg
from retrace import SpanType, TraceRecorder


@patch("retrace.recorder.create_transport")
def test_span_ended_omits_null_error(mt):
    m = MagicMock()
    mt.return_value = m
    cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)

    rec = TraceRecorder(name="payload-test")
    rec.start_trace()
    s = rec.start_span("do_tool", SpanType.TOOL_CALL, input={"a": 1})
    rec.end_span(s.id, output={"ok": True})  # success, no error
    rec.end_trace(output={"done": True})

    ended = [c[0][1] for c in m.send.call_args_list if c[0][0] == "span_ended"]
    assert ended, "expected at least one span_ended event"
    for e in ended:
        # error must be absent (not present as null) for a successful span.
        assert e.get("error") is not None or "error" not in e, f"span_ended carried null error: {e}"
        assert "error" not in e, f"successful span_ended must omit error entirely: {e}"


@patch("retrace.recorder.create_transport")
def test_span_ended_keeps_real_error(mt):
    m = MagicMock()
    mt.return_value = m
    cfg.configure(api_key="rt_live_t", base_url="http://x:1", enabled=True)

    rec = TraceRecorder(name="payload-test-err")
    rec.start_trace()
    s = rec.start_span("do_tool", SpanType.TOOL_CALL, input={"a": 1})
    rec.end_span(s.id, error="BoomError: failed")
    rec.end_trace(output={"done": False})

    ended = [c[0][1] for c in m.send.call_args_list if c[0][0] == "span_ended"]
    assert any(e.get("error") == "BoomError: failed" for e in ended), "real error must be preserved"
