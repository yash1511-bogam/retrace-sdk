"""Framework adapters for Retrace.

These emit STRUCTURED chain/tool/retrieval/agent spans aligned with the detection engine.
LLM spans are already captured by the provider interceptors (``retrace.init()`` / ``@record``),
so adapters focus on the framework-specific structure detectors rely on.
"""
from .crewai import instrument_crew, retrace_step_callback, retrace_task_callback
from .langchain import RetraceCallbackHandler, get_callback_handler

__all__ = [
    "RetraceCallbackHandler",
    "get_callback_handler",
    "instrument_crew",
    "retrace_step_callback",
    "retrace_task_callback",
]
