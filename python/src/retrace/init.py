"""Zero-config, one-line initialization for the Retrace SDK."""
from __future__ import annotations

import atexit
import logging
import os
import sys
from typing import Any, Optional

from .config import configure, get_config, require_api_key
from .recorder import TraceRecorder
from .trace import TraceStatus

logger = logging.getLogger("retrace")

_ambient: Optional[TraceRecorder] = None
_exit_hooked = False


def _default_name(explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("RETRACE_TRACE_NAME")
    if env:
        return env
    argv0 = sys.argv[0] if sys.argv else ""
    if argv0:
        base = os.path.basename(argv0)
        if base:
            return base.rsplit(".", 1)[0] if "." in base else base
    return "agent"


def init(
    name: str | None = None,
    api_key: str | None = None,
    auto_trace: bool = True,
    metadata: dict | None = None,
    **kwargs,
) -> Optional[TraceRecorder]:
    """One-line zero-config init.

    Reads ``RETRACE_API_KEY`` from the environment (or pass ``api_key``), auto-patches any
    installed provider SDK (OpenAI / Anthropic / Gemini), and auto-starts an ambient trace so
    every LLM + tool call is captured with NO ``@record`` / ``start_span`` boilerplate. The
    ambient trace is flushed and ended automatically on interpreter exit.

    ::

        import retrace
        retrace.init()                 # RETRACE_API_KEY from env
        # ...use openai / anthropic / gemini normally — auto-recorded

    Intended for scripts and single-run agents. Long-lived servers should keep using
    ``@retrace.record`` per request so each request is its own trace.
    """
    global _ambient, _exit_hooked
    if api_key:
        kwargs["api_key"] = api_key
    configure(**kwargs)
    require_api_key()
    cfg = get_config()
    if not cfg.enabled or not auto_trace:
        return None
    if _ambient is not None:
        return _ambient

    trace_name = _default_name(name)
    _ambient = TraceRecorder(name=trace_name, metadata=metadata)
    _ambient.start_trace(trace_name)  # installs the provider interceptors against the ambient recorder

    if not _exit_hooked:
        _exit_hooked = True
        atexit.register(_shutdown_atexit)
        # SIGTERM path (container stop / k8s): the transport's sole-owner SIGTERM handler runs this
        # hook before draining, so the ambient trace is finalized terminated_early (interrupted run)
        # rather than lost. atexit (graceful) keeps finishing it COMPLETED via _shutdown_atexit; the
        # two paths are mutually exclusive (atexit doesn't run on SIGTERM) and both clear _ambient.
        from .recorder import on_process_exit
        on_process_exit(_finish_ambient_on_signal)
        # atexit is Python's GRACEFUL path (normal exit / sys.exit) — it does NOT run on SIGTERM or
        # SIGKILL — so ending the ambient COMPLETED there is correct. The one gap is an unhandled
        # exception: atexit still runs, which would stamp a clean COMPLETED on a crashed run. Close
        # it with a chained sys.excepthook (FAILED + terminated_early). We chain (not seize): the
        # prior hook is always invoked, so a framework's excepthook keeps working.
        _prior_excepthook = sys.excepthook

        def _retrace_excepthook(exc_type, exc, tb):
            global _ambient
            rec = _ambient
            _ambient = None
            if rec is not None:
                try:
                    rec.end_trace(status=TraceStatus.FAILED, terminated_early=True)
                except Exception:  # never let our finalization mask the user's traceback
                    pass
            _prior_excepthook(exc_type, exc, tb)

        sys.excepthook = _retrace_excepthook
    return _ambient


def get_active_recorder() -> Optional[TraceRecorder]:
    """The ambient recorder started by :func:`init`, if any."""
    return _ambient


def shutdown(output: Any = None, status: TraceStatus = TraceStatus.COMPLETED) -> None:
    """Manually end the ambient trace (e.g. with a final output) before exit. Idempotent."""
    global _ambient
    rec = _ambient
    _ambient = None
    if rec is not None:
        rec.end_trace(output=output, status=status)


def _finish_ambient_on_signal(reason: str) -> None:
    """Finish the ambient trace on a SIGTERM-interrupted run, marked terminated_early so it is NOT
    byte-replayable (a clean COMPLETED would defeat the replay-guard's no-terminal rule)."""
    global _ambient
    rec = _ambient
    _ambient = None
    if rec is not None:
        try:
            rec.end_trace(status=TraceStatus.COMPLETED, terminated_early=True)
        except Exception as e:
            logger.debug(f"ambient trace signal-finalize failed: {e}")


def _shutdown_atexit() -> None:
    global _ambient
    rec = _ambient
    _ambient = None
    if rec is not None:
        try:
            rec.end_trace(status=TraceStatus.COMPLETED)
        except Exception as e:  # best effort on interpreter shutdown
            logger.debug(f"ambient trace shutdown failed: {e}")
