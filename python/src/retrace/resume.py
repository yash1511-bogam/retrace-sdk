"""Full cascade replay for Retrace.

When @record(resumable=True) is used, the SDK:
1. Stores the decorated function reference
2. Listens for 'resume' commands on the WebSocket
3. On resume: re-executes the function from the fork point with modified input
4. Streams new spans back to the API

This enables "Git branching for AI agent execution."
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Any, Callable, Optional
from dataclasses import dataclass, field

logger = logging.getLogger("retrace")

# Registry of resumable functions
_resumable_functions: dict[str, Callable] = {}
_resume_lock = threading.Lock()


def register_resumable(trace_name: str, fn: Callable):
    """Register a function as resumable for cascade replay."""
    with _resume_lock:
        _resumable_functions[trace_name] = fn


def get_resumable(trace_name: str) -> Optional[Callable]:
    """Get a registered resumable function."""
    with _resume_lock:
        return _resumable_functions.get(trace_name)


@dataclass
class ResumeCommand:
    """Command received from API to resume execution."""
    fork_id: str
    trace_id: str
    trace_name: str
    fork_point_span_id: str
    modified_input: Any
    original_args: Any = None
    original_kwargs: Any = None


def handle_resume(command: ResumeCommand) -> bool:
    """Handle a resume command — re-execute the agent function.
    
    Returns True if the function was found and re-execution started.
    """
    fn = get_resumable(command.trace_name)
    if not fn:
        logger.warning(f"[retrace] No resumable function registered for '{command.trace_name}'")
        return False

    # Re-execute in a background thread to not block the WebSocket
    def _run():
        try:
            from .recorder import TraceRecorder
            from .trace import TraceStatus
            from .config import get_config

            # Create a new trace for the fork result
            recorder = TraceRecorder(
                name=f"Fork: {command.trace_name}",
                input=command.modified_input,
                metadata={
                    "_fork_id": command.fork_id,
                    "_fork_of": command.trace_id,
                    "_fork_point": command.fork_point_span_id,
                    "_cascade_replay": True,
                },
            )
            recorder.start_trace()

            # Re-execute with modified input
            args = command.original_args or []
            kwargs = command.original_kwargs or {}

            # If modified_input is a string, use it as the first arg
            if isinstance(command.modified_input, str):
                args = [command.modified_input] + list(args[1:]) if args else [command.modified_input]
            elif isinstance(command.modified_input, dict):
                kwargs = {**kwargs, **command.modified_input}

            result = fn(*args, **kwargs)
            recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
            logger.info(f"[retrace] Cascade replay completed for fork {command.fork_id}")
        except Exception as e:
            logger.error(f"[retrace] Cascade replay failed: {e}")
            try:
                recorder.end_trace(status=TraceStatus.FAILED)
            except:
                pass

    thread = threading.Thread(target=_run, daemon=True, name=f"retrace-replay-{command.fork_id}")
    thread.start()
    return True


def parse_resume_message(msg: dict) -> Optional[ResumeCommand]:
    """Parse a WebSocket message into a ResumeCommand."""
    if msg.get("type") != "resume":
        return None
    data = msg.get("data", {})
    return ResumeCommand(
        fork_id=data.get("forkId", ""),
        trace_id=data.get("traceId", ""),
        trace_name=data.get("traceName", ""),
        fork_point_span_id=data.get("forkPointSpanId", ""),
        modified_input=data.get("modifiedInput"),
        original_args=data.get("originalArgs"),
        original_kwargs=data.get("originalKwargs"),
    )
