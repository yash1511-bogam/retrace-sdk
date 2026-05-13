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
        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        span_id = str(uuid.uuid4())
        start = time.time()

        try:
            result = _original_create(self, *args, **kwargs)
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
