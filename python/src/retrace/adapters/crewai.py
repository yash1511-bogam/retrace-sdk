"""CrewAI adapter for Retrace.

CrewAI calls its LLMs through the provider SDKs, so the LLM spans are already captured by the
provider interceptors (``retrace.init()`` / ``@record``). This adapter adds the missing
STRUCTURED agent/tool/task spans by attaching CrewAI's ``step_callback`` / ``task_callback``,
so loop, schema and tool-output detectors work on CrewAI runs.

Usage::

    import retrace
    from retrace.adapters.crewai import instrument_crew

    retrace.init()
    crew = instrument_crew(Crew(agents=[...], tasks=[...]))
    crew.kickoff()
"""
from __future__ import annotations

import json
import logging
from typing import Any

from ..init import get_active_recorder
from ..trace import SpanType

logger = logging.getLogger("retrace")


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


def retrace_step_callback(step_output: Any, recorder: Any = None) -> None:
    """Map a CrewAI step (AgentAction / AgentFinish / tool result) to a structured span."""
    rec = recorder or get_active_recorder()
    if not rec:
        return
    tool = getattr(step_output, "tool", None)
    if tool:
        span = rec.start_span(
            name=str(tool), span_type=SpanType.TOOL_CALL,
            input=_truncate(getattr(step_output, "tool_input", None)),
        )
        result = getattr(step_output, "result", None)
        rec.end_span(span.id, output=_truncate(result if result is not None else getattr(step_output, "log", None)))
        if result is not None:
            tr = rec.start_span(name="tool_result", span_type=SpanType.TOOL_RESULT, input=None)
            rec.end_span(tr.id, output=_truncate(result))
    else:
        text = getattr(step_output, "log", None) or getattr(step_output, "text", None) or str(step_output)
        span = rec.start_span(name="agent_step", span_type=SpanType.REASONING, input=None)
        rec.end_span(span.id, output=_truncate(text))


def retrace_task_callback(task_output: Any, recorder: Any = None) -> None:
    """Map a completed CrewAI task to an ``action`` span."""
    rec = recorder or get_active_recorder()
    if not rec:
        return
    raw = getattr(task_output, "raw", None) or getattr(task_output, "raw_output", None) or str(task_output)
    name = getattr(task_output, "name", None) or "task"
    span = rec.start_span(name=str(name), span_type=SpanType.ACTION, input=None)
    rec.end_span(span.id, output=_truncate(raw))


def instrument_crew(crew: Any, recorder: Any = None) -> Any:
    """Attach Retrace step/task callbacks to a CrewAI Crew (non-destructive — won't clobber existing)."""
    if getattr(crew, "step_callback", None) is None:
        try:
            crew.step_callback = lambda s: retrace_step_callback(s, recorder)
        except Exception as e:  # some CrewAI versions use pydantic models with restricted setattr
            logger.debug(f"could not set crew.step_callback: {e}")
    if getattr(crew, "task_callback", None) is None:
        try:
            crew.task_callback = lambda t: retrace_task_callback(t, recorder)
        except Exception as e:
            logger.debug(f"could not set crew.task_callback: {e}")
    return crew
