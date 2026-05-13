"""OpenAI interceptor for Retrace Python SDK."""
import time
import uuid
from typing import Callable

_original_create = None
_installed = False
_on_span = None

PRICING = {
    # GPT-5.5 series
    "gpt-5.5-pro": (30.0, 180.0),
    "gpt-5.5": (5.0, 30.0),
    # GPT-5.4 series
    "gpt-5.4-pro": (15.0, 90.0),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.20),
    "gpt-5.4": (2.50, 15.0),
    # GPT-5 series
    "gpt-5-mini": (0.50, 3.0),
    "gpt-5-nano": (0.10, 0.60),
    "gpt-5": (1.25, 10.0),
    # GPT-4.1
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1": (2.0, 8.0),
    # Legacy
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.0),
    # Reasoning
    "o3": (10.0, 40.0),
    "o4-mini": (1.10, 4.40),
    "o3-mini": (1.10, 4.40),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    for key, p in PRICING.items():
        if key in model:
            return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000
    return 0.0


def install_openai_interceptor(on_span=None):
    global _original_create, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        return

    try:
        from openai.resources.chat.completions import Completions
    except ImportError:
        return

    _on_span = on_span
    _original_create = Completions.create

    def patched_create(self, *args, **kwargs):
        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        span_id = str(uuid.uuid4())
        start = time.time()

        try:
            result = _original_create(self, *args, **kwargs)
            duration_ms = int((time.time() - start) * 1000)
            usage = getattr(result, "usage", None)
            input_tokens = getattr(usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(usage, "completion_tokens", 0) or 0
            output = ""
            if hasattr(result, "choices") and result.choices:
                msg = result.choices[0].message
                output = getattr(msg, "content", "") or ""

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": f"openai.chat.completions.create",
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
                    "name": f"openai.chat.completions.create",
                    "model": model,
                    "input": {"messages": [{"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]} for m in messages[:10]]},
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    Completions.create = patched_create
    _installed = True


def uninstall_openai_interceptor():
    global _installed, _on_span, _original_create
    if not _installed or not _original_create:
        return
    try:
        from openai.resources.chat.completions import Completions
        Completions.create = _original_create
    except ImportError:
        pass
    _installed = False
    _on_span = None
