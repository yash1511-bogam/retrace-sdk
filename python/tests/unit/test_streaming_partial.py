"""H4: streaming spans must be labeled by completeness so the server's byte-replay taint is correct.
A fully-drained stream -> capture_complete True; a stream abandoned early -> partial + not complete.
"""
import time
from types import SimpleNamespace

from retrace.interceptors import anthropic as a


def _delta(text):
    return SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(text=text, partial_json=None))


def _capture(monkeypatch):
    spans = []
    monkeypatch.setattr(a, "_on_span", lambda s: spans.append(s))
    return spans


def test_fully_drained_stream_is_capture_complete(monkeypatch):
    spans = _capture(monkeypatch)
    stream = iter([_delta("hel"), _delta("lo")])
    gen = a._wrap_anthropic_stream(stream, "sp1", "claude-3-5", [{"role": "user", "content": "hi"}], time.time())
    out = list(gen)  # drain fully
    assert len(out) == 2
    llm = next(s for s in spans if s["span_type"] == "llm_call")
    assert llm["metadata"]["capture_complete"] is True
    assert "partial" not in llm["metadata"]


def test_early_break_stream_is_partial(monkeypatch):
    spans = _capture(monkeypatch)
    stream = iter([_delta("hel"), _delta("lo"), _delta("!")])
    gen = a._wrap_anthropic_stream(stream, "sp2", "claude-3-5", [{"role": "user", "content": "hi"}], time.time())
    next(gen)          # consume one chunk only
    gen.close()        # abandon the stream -> finally runs without completed=True
    llm = next(s for s in spans if s["span_type"] == "llm_call")
    assert llm["metadata"]["capture_complete"] is False
    assert llm["metadata"]["partial"] is True


def test_span_survives_trace_context_exit(monkeypatch):
    """Backstop: a stream finalized AFTER its trace context exits must still emit (not be dropped).
    The wrapper binds the active sink at stream start + registers a trace-end finalizer, so even
    when the dispatcher ContextVar has been reset to None, the span reaches the captured emit."""
    from retrace.interceptors import _dispatch
    captured = []
    stored = {}

    class FakeSink:
        def register_open_span(self, sid, fin):
            stored[sid] = fin

        def unregister_open_span(self, sid):
            stored.pop(sid, None)

    # Only emit path is the bound (captured) sink — module global is cleared, so a re-resolve at
    # finalize time would yield None and drop the span if the backstop weren't wired.
    monkeypatch.setattr(a, "_on_span", None)
    token = _dispatch.set_active_recorder(lambda s: captured.append(s), FakeSink())
    gen = a._wrap_anthropic_stream(iter([_delta("hi")]), "sp9", "claude", [{"role": "user", "content": "x"}], time.time())
    assert "sp9" in stored                 # registered with the trace-end sink
    _dispatch.reset_active_recorder(token)  # trace context exits -> ContextVar now None
    del gen                                 # generator never drained
    stored["sp9"]("partial")               # trace-end backstop finalizes the open span
    assert len(captured) == 1              # span emitted, NOT dropped
    assert captured[0]["metadata"]["capture_complete"] is False
