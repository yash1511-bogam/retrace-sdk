"""LangChain / LangGraph adapter for Retrace.

A drop-in ``BaseCallbackHandler`` that emits STRUCTURED tool / retrieval / chain spans into the
active Retrace trace, with span shapes aligned to the detectors:

- ``on_tool_start`` → a ``tool_call`` span (structured args) — feeds schema-violation (2C).
- ``on_tool_end``   → closes the call + emits a verbatim ``tool_result`` span — feeds tool-output
  hallucination (3C) and loop detection (2D).
- ``on_retriever_*`` → an ``action`` span carrying the retrieved documents (replay divergence 2A).
- ``on_chain_* / on_agent_action`` → ``reasoning`` / ``tool_call`` steps.

LLM spans themselves are already captured by the provider interceptors (``init()`` / ``@record``),
so this handler deliberately does not emit ``llm_call`` spans (no double counting).

Usage::

    import retrace
    from retrace.adapters.langchain import RetraceCallbackHandler

    retrace.init()                                   # ambient trace + provider patching
    agent.invoke(input, config={"callbacks": [RetraceCallbackHandler()]})
"""
from __future__ import annotations

import json
import logging
from typing import Any

from ..init import get_active_recorder
from ..trace import SpanType

logger = logging.getLogger("retrace")

try:  # langchain-core is an OPTIONAL peer dependency
    from langchain_core.callbacks import BaseCallbackHandler as _Base  # type: ignore
    _HAS_LANGCHAIN = True
except Exception:  # pragma: no cover - exercised only without langchain installed
    _Base = object  # type: ignore
    _HAS_LANGCHAIN = False


def _truncate(value: Any, limit: int = 4000) -> Any:
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return value[:limit]
    try:
        s = json.dumps(value, default=str)
    except Exception:
        s = str(value)
    return s[:limit]


class RetraceCallbackHandler(_Base):  # type: ignore[misc]
    """LangChain/LangGraph callback handler that records structured spans into a Retrace trace."""

    def __init__(self, recorder: Any = None):
        super().__init__()
        self._recorder = recorder
        self._open: dict[str, str] = {}  # run_id -> span_id

    def _rec(self):
        return self._recorder or get_active_recorder()

    # ── Tools ────────────────────────────────────────────────────────────────
    def on_tool_start(self, serialized: dict | None, input_str: str, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        name = (serialized or {}).get("name") or "tool"
        args = kwargs.get("inputs") or input_str
        span = rec.start_span(name=str(name), span_type=SpanType.TOOL_CALL, input=_truncate(args))
        if run_id is not None:
            self._open[str(run_id)] = span.id

    def on_tool_end(self, output: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        out = _truncate(getattr(output, "content", output))
        sid = self._open.pop(str(run_id), None)
        if sid:
            rec.end_span(sid, output=out)
        # Verbatim tool_result span (what the detectors compare model claims against).
        result = rec.start_span(name="tool_result", span_type=SpanType.TOOL_RESULT, input=None)
        rec.end_span(result.id, output=out)

    def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        sid = self._open.pop(str(run_id), None)
        if rec and sid:
            rec.end_span(sid, error=str(error))

    # ── Retriever ────────────────────────────────────────────────────────────
    def on_retriever_start(self, serialized: dict | None, query: str, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        span = rec.start_span(name="retrieval", span_type=SpanType.ACTION, input=_truncate(query))
        if run_id is not None:
            self._open[str(run_id)] = span.id

    def on_retriever_end(self, documents: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        docs = [getattr(d, "page_content", str(d)) for d in (documents or [])]
        sid = self._open.pop(str(run_id), None)
        if sid:
            rec.end_span(sid, output=_truncate({"count": len(docs), "documents": docs}))

    # ── Chains / agents ──────────────────────────────────────────────────────
    def on_chain_start(self, serialized: dict | None, inputs: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        name = "chain"
        if serialized:
            name = serialized.get("name") or (serialized.get("id") or ["chain"])[-1]
        span = rec.start_span(name=str(name), span_type=SpanType.REASONING, input=_truncate(inputs))
        if run_id is not None:
            self._open[str(run_id)] = span.id

    def on_chain_end(self, outputs: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        sid = self._open.pop(str(run_id), None)
        if rec and sid:
            rec.end_span(sid, output=_truncate(outputs))

    def on_chain_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        sid = self._open.pop(str(run_id), None)
        if rec and sid:
            rec.end_span(sid, error=str(error))

    def on_agent_action(self, action: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        rec = self._rec()
        if not rec:
            return
        tool = getattr(action, "tool", "action")
        span = rec.start_span(
            name=str(tool), span_type=SpanType.TOOL_CALL,
            input=_truncate(getattr(action, "tool_input", None)),
        )
        rec.end_span(span.id, output=_truncate(getattr(action, "log", None)))


def get_callback_handler(recorder: Any = None) -> RetraceCallbackHandler:
    """Return a Retrace LangChain callback handler. Raises if langchain-core isn't installed."""
    if not _HAS_LANGCHAIN:
        raise ImportError("langchain-core is not installed. Run: pip install langchain-core")
    return RetraceCallbackHandler(recorder)
