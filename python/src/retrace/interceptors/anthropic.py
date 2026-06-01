"""Anthropic interceptor for Retrace Python SDK."""
import time
import uuid
from typing import Callable

_original_create = None
_installed = False
_on_span = None

PRICING = {
    # Opus
    "claude-opus-4.7": (5.0, 25.0),
    "claude-opus-4.6": (5.0, 25.0),
    # Sonnet
    "claude-sonnet-4.6": (3.0, 15.0),
    "claude-sonnet-4": (3.0, 15.0),
    # Haiku
    "claude-haiku-4.5": (1.0, 5.0),
    # Legacy
    "claude-3-7-sonnet": (3.0, 15.0),
    "claude-3-5-sonnet": (3.0, 15.0),
    "claude-3-5-haiku": (0.80, 4.0),
    "claude-3-opus": (15.0, 75.0),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    for key, p in PRICING.items():
        if key in model:
            return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000
    return 0.0


def _wrap_anthropic_stream(stream, span_id, model, messages, start):
    """Wrap Anthropic streaming response to collect text deltas and emit span."""
    chunks = []
    input_tokens = 0
    output_tokens = 0

    def _gen():
        nonlocal input_tokens, output_tokens
        try:
            for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "content_block_delta":
                    delta = getattr(getattr(event, "delta", None), "text", None)
                    if delta:
                        chunks.append(delta)
                elif event_type == "message_start":
                    msg = getattr(event, "message", None)
                    if msg and hasattr(msg, "usage"):
                        input_tokens = getattr(msg.usage, "input_tokens", 0) or 0
                elif event_type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        output_tokens = getattr(usage, "output_tokens", 0) or 0
                yield event
        finally:
            duration_ms = int((time.time() - start) * 1000)
            output = "".join(chunks)
            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "anthropic.messages.create",
                    "model": model,
                    "input": {"messages": [{"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]} for m in messages[:10]]},
                    "output": output[:2000],
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": _calc_cost(model, input_tokens, output_tokens),
                    "duration_ms": duration_ms,
                    "metadata": {"streaming": True},
                })

    return _gen()


def install_anthropic_interceptor(on_span=None):
    global _original_create, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        return

    try:
        from anthropic.resources.messages import Messages
    except ImportError:
        return

    _on_span = on_span
    _original_create = Messages.create

    def patched_create(self, *args, **kwargs):
        from retrace.replay import is_replaying, consume_cassette_entry

        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        is_streaming = kwargs.get("stream", False)
        span_id = str(uuid.uuid4())

        # Replay mode — return mocked response from cassette
        if is_replaying():
            entry = consume_cassette_entry("anthropic.messages.create", "llm_call")
            if entry:
                from unittest.mock import MagicMock
                mock = MagicMock()
                mock.content = [MagicMock()]
                mock.content[0].text = entry.get("output", "")
                mock.content[0].type = "text"
                mock.usage.input_tokens = entry.get("input_tokens", 0)
                mock.usage.output_tokens = entry.get("output_tokens", 0)
                mock.model = model
                mock.role = "assistant"
                return mock

        start = time.time()

        try:
            result = _original_create(self, *args, **kwargs)

            # Streaming: wrap iterator to collect chunks and emit span on completion
            if is_streaming and hasattr(result, "__iter__"):
                return _wrap_anthropic_stream(result, span_id, model, messages, start)

            duration_ms = int((time.time() - start) * 1000)
            usage = getattr(result, "usage", None)
            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0
            output = ""
            if hasattr(result, "content") and result.content:
                output = getattr(result.content[0], "text", "") if result.content else ""

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "anthropic.messages.create",
                    "model": model,
                    "input": {"messages": [{"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]} for m in messages[:10]]},
                    "output": output[:2000],
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": _calc_cost(model, input_tokens, output_tokens),
                    "duration_ms": duration_ms,
                })
            return result
        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "anthropic.messages.create",
                    "model": model,
                    "input": {"messages": [{"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]} for m in messages[:10]]},
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    Messages.create = patched_create
    _installed = True


def uninstall_anthropic_interceptor():
    global _installed, _on_span, _original_create
    if not _installed or not _original_create:
        return
    try:
        from anthropic.resources.messages import Messages
        Messages.create = _original_create
    except ImportError:
        pass
    _installed = False
    _on_span = None
