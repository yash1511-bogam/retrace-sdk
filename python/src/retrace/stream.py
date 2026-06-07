"""``stream()`` — opt-in full-fidelity wrapper for an LLM stream.

Wrap a provider stream so the auto-captured span observes a CLEAN full drain even if you stop
iterating early — giving you a byte-replay-eligible span (``capture_complete: True``) for a stream
you only partially consume::

    for chunk in retrace.stream(client.models.generate_content_stream(...)):
        render(chunk)
        if enough:
            break   # the rest is still drained → full capture

It does NOT record its own span — it relies on the auto-interceptor's capture, so the
function-call rule still applies: a stream that emits a function call stays
``capture_complete: False`` regardless of how it's drained. The helper's guarantee is
"true when there is no function call", never "true, period".

Opt-in cost: if you break early, the remainder of the stream is still consumed (the provider may
bill for the full generation) — so wrapping with ``stream()`` TRADES AWAY the cost/latency savings
of your early stop in exchange for guaranteed full-fidelity capture. If you broke early to save
money, do not wrap with ``stream()``.
"""
from __future__ import annotations

from typing import Iterable, Iterator


def stream(src: Iterable) -> Iterator:
    it = iter(src)
    drained_to_end = False
    try:
        while True:
            try:
                chunk = next(it)
            except StopIteration:
                drained_to_end = True
                break
            yield chunk
    finally:
        # Consumer broke early — finish draining the source so the auto-captured span sees a clean
        # drain. (Function-call streams still finalize capture_complete:False in the auto path.)
        if not drained_to_end:
            try:
                for _ in it:
                    pass
            except Exception:
                pass
