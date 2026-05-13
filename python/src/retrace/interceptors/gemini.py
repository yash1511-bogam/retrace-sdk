"""Gemini interceptor for Retrace Python SDK."""
import time
import uuid
from typing import Callable

_original_generate = None
_installed = False
_on_span = None

PRICING = {
    # Gemini 3 series
    "gemini-3.1-flash-lite": (0.10, 0.40),
    "gemini-3.1-flash": (0.50, 3.0),
    "gemini-3-flash": (0.50, 3.0),
    "gemini-3-pro": (2.0, 12.0),
    "gemini-3.1-pro-preview": (2.0, 12.0),
    # Gemini 2.x
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.0-flash-lite": (0.05, 0.20),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = PRICING.get(model, (0, 0))
    return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000


def install_gemini_interceptor(on_span=None):
    global _original_generate, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        return

    try:
        from google import genai
    except ImportError:
        return

    _on_span = on_span
    _original_generate = genai.models.Models.generate_content

    def patched_generate(self, *args, **kwargs):
        model = kwargs.get("model", args[0] if args else "unknown")
        contents = kwargs.get("contents", args[1] if len(args) > 1 else None)
        span_id = str(uuid.uuid4())
        start = time.time()

        try:
            result = _original_generate(self, *args, **kwargs)
            duration_ms = int((time.time() - start) * 1000)
            input_tokens = getattr(getattr(result, "usage_metadata", None), "prompt_token_count", 0) or 0
            output_tokens = getattr(getattr(result, "usage_metadata", None), "candidates_token_count", 0) or 0

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "retrace.ai.generate",
                    "model": model,
                    "input": str(contents)[:2000] if contents else None,
                    "output": getattr(result, "text", "")[:2000],
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
                    "name": "retrace.ai.generate",
                    "model": model,
                    "input": str(contents)[:2000] if contents else None,
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    genai.models.Models.generate_content = patched_generate
    _installed = True


def uninstall_gemini_interceptor():
    global _installed, _on_span, _original_generate
    if not _installed or not _original_generate:
        return
    try:
        from google import genai
        genai.models.Models.generate_content = _original_generate
    except ImportError:
        pass
    _installed = False
    _on_span = None
