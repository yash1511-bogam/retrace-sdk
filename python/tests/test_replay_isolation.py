"""Replay isolation: the cassette must never leak across execution contexts."""
import threading

from retrace import replay


def test_replay_cassette_is_context_isolated():
    """A cassette activated in one context must NOT make a concurrent thread replay.

    This is the guard against the regression where a module-global cassette caused a
    server-pushed replay to hijack a live, concurrent production LLM call.
    """
    replay.activate_cassette([{"name": "x", "span_type": "llm_call", "output": "recorded"}])
    try:
        assert replay.is_replaying() is True

        seen = {}

        def worker():
            seen["replaying"] = replay.is_replaying()
            seen["entry"] = replay.consume_cassette_entry("x", "llm_call")

        t = threading.Thread(target=worker)
        t.start()
        t.join()

        # The other thread has its own context — it must not be in replay mode.
        assert seen["replaying"] is False
        assert seen["entry"] is None
    finally:
        replay.deactivate_cassette()

    assert replay.is_replaying() is False


def test_consume_cassette_entry_matches_by_name_and_type():
    replay.activate_cassette([
        {"name": "openai.chat.completions.create", "span_type": "llm_call", "output": "hi"},
    ])
    try:
        entry = replay.consume_cassette_entry("openai.chat.completions.create", "llm_call")
        assert entry is not None and entry["output"] == "hi"
        # Exhausted now.
        assert replay.consume_cassette_entry("openai.chat.completions.create", "llm_call") is None
    finally:
        replay.deactivate_cassette()
