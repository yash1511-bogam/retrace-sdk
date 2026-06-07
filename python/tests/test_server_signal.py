import logging

import retrace
from retrace.errors import classify_server_signal
from retrace.transport import WSTransport


def test_classify_structured():
    s = classify_server_signal("error", "Monthly limit reached")
    assert s.code == "credits_exhausted" and s.retryable is False and s.fatal is False
    r = classify_server_signal("error", "Rate limit exceeded")
    assert r.code == "rate_limited" and r.retryable is True and r.fatal is False
    h = classify_server_signal("halt", "budget")
    assert h.code == "halt" and h.fatal is True and h.retryable is False
    e = classify_server_signal("error", "weird unmatched text")
    assert e.code == "error" and e.retryable is False and e.fatal is False


def test_fp6_error_frame_surfaces_to_on_error():
    """F-P6: a server `error` frame (previously SWALLOWED) must surface as a structured signal."""
    got = []
    retrace.configure(api_key="rt_live_x", on_error=lambda s: got.append(s))
    t = WSTransport()
    t._dispatch({"type": "error", "error": "Rate limit exceeded"})
    assert len(got) == 1
    assert got[0].code == "rate_limited" and got[0].retryable is True


def test_throwing_callback_does_not_kill_listener():
    def boom(_):
        raise RuntimeError("user callback bug")
    retrace.configure(api_key="rt_live_x", on_error=boom)
    t = WSTransport()
    # Must NOT raise — a buggy user callback can't take down the WS listener thread.
    t._dispatch({"type": "error", "error": "boom"})


def test_unknown_type_warns_and_is_throttled(caplog):
    """F-P6 durable fix: unknown/unhandled message types throttled-warn, never silently swallowed."""
    retrace.configure(api_key="rt_live_x", on_error=None)
    t = WSTransport()
    with caplog.at_level(logging.WARNING, logger="retrace"):
        t._dispatch({"type": "zzz_future_type"})
        t._dispatch({"type": "zzz_future_type"})  # within 5s → throttled
    warns = [r for r in caplog.records if "zzz_future_type" in r.getMessage()]
    assert len(warns) == 1


def test_default_warn_throttled_no_callback(caplog):
    retrace.configure(api_key="rt_live_x", on_error=None)
    t = WSTransport()
    with caplog.at_level(logging.WARNING, logger="retrace"):
        t._dispatch({"type": "error", "error": "Rate limit exceeded"})
        t._dispatch({"type": "error", "error": "Rate limit exceeded"})  # throttled
    warns = [r for r in caplog.records if "rate_limited" in r.getMessage()]
    assert len(warns) == 1
