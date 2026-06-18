"""Conservative fallback pricing for models not present in an interceptor's price table.

A model that matches no key (a brand-new release, a fine-tune, an OpenRouter alias) would otherwise
be costed at $0 — and a $0 cost silently disarms USD budget ceilings in the enforcement gate (the
gate trips on estimated USD per run). Cost unknown models at a conservative mid/high frontier rate
instead so a cap still engages; the value self-corrects once the server price table learns the model.

$/1M tokens: (input, output).
"""

UNKNOWN_MODEL_PRICING: tuple[float, float] = (5.0, 15.0)


def cost_from_rate(rate: tuple[float, float], input_tokens: int, output_tokens: int) -> float:
    """Cost in USD from an (input, output) $/1M-token rate."""
    return (input_tokens * rate[0] + output_tokens * rate[1]) / 1_000_000
