"""Deterministic Replay with Cassettes for Retrace Python SDK.

When the server sends a "replay" command, the SDK:
1. Loads the cassette (recorded span inputs/outputs)
2. Sets up a thread-local cassette store
3. Re-executes the trace function
4. Tool calls can check the cassette for recorded outputs

Usage in tool implementations:
    from retrace.replay import is_replaying, consume_cassette_entry

    def my_tool(query: str):
        entry = consume_cassette_entry("my_tool", "tool_call")
        if entry:
            return entry["output"]  # Return recorded output during replay
        # Normal execution
        return actual_tool_call(query)
"""
from __future__ import annotations

import contextvars
import logging
import threading
from dataclasses import dataclass
from typing import Any, Optional

from .resume import get_resumable

logger = logging.getLogger("retrace")

# Replay cassette state is held in CONTEXT VARIABLES — not module globals — so an active
# replay (run on its own thread/task by handle_replay) is isolated to that execution context
# and can NEVER cause a concurrent live LLM call on another thread/task to return recorded
# output. A module global here would hijack the user's real production calls.
_cassette_var: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar("retrace_replay_cassette", default=None)
_pointer_var: contextvars.ContextVar[int] = contextvars.ContextVar("retrace_replay_pointer", default=0)


@dataclass
class ReplayCommand:
    """Command received from API to replay a trace with cassette."""
    trace_id: str
    trace_name: str
    input: Any
    cassette: list[dict]


def is_replaying() -> bool:
    """Check if a deterministic replay is active in the CURRENT execution context."""
    return _cassette_var.get() is not None


def activate_cassette(cassette: list) -> None:
    """Activate a cassette for the current execution context (the replay thread/task only)."""
    _cassette_var.set(cassette)
    _pointer_var.set(0)


def deactivate_cassette() -> None:
    """Clear the cassette for the current execution context."""
    _cassette_var.set(None)
    _pointer_var.set(0)


def consume_cassette_entry(name: str, span_type: str) -> Optional[dict]:
    """Get the next cassette entry matching a span name and type.

    Uses sequential matching with name-based fallback for deterministic replay.
    Reads only the CURRENT context's cassette, so concurrent live calls are unaffected.
    Returns the full entry dict with 'output', 'error', etc. or None if not replaying.
    """
    cassette = _cassette_var.get()
    if cassette is None:
        return None

    ptr = _pointer_var.get()
    # Primary: sequential pointer (deterministic order)
    if ptr < len(cassette):
        entry = cassette[ptr]
        if entry.get("name") == name and entry.get("span_type") == span_type:
            _pointer_var.set(ptr + 1)
            return entry

    # Fallback: search by name + type from current pointer forward
    for i in range(ptr, len(cassette)):
        if cassette[i].get("name") == name and cassette[i].get("span_type") == span_type:
            _pointer_var.set(i + 1)
            return cassette[i]

    return None


def handle_replay(command: ReplayCommand) -> bool:
    """Handle a replay command — re-execute with cassette-mocked tool calls.

    Returns True if the function was found and re-execution started.
    """
    fn = get_resumable(command.trace_name)
    if not fn:
        logger.warning(f"[retrace] No resumable function registered for '{command.trace_name}'")
        return False

    def _run():
        try:
            from .recorder import TraceRecorder
            from .trace import TraceStatus

            # Activate the cassette for THIS thread's context only — never globally.
            activate_cassette(command.cassette)

            recorder = TraceRecorder(
                name=f"Replay: {command.trace_name}",
                input=command.input,
                metadata={
                    "_replay_of": command.trace_id,
                    "_deterministic_replay": True,
                    "_cassette_size": len(command.cassette),
                },
            )
            recorder.start_trace()

            # Determine args
            if isinstance(command.input, str):
                args = [command.input]
            elif isinstance(command.input, list):
                args = command.input
            else:
                args = [command.input]

            result = fn(*args)
            recorder.end_trace(output=result, status=TraceStatus.COMPLETED)
            logger.info(f"[retrace] Deterministic replay completed for trace {command.trace_id}")
        except Exception as e:
            logger.error(f"[retrace] Deterministic replay failed: {e}")
        finally:
            deactivate_cassette()

    thread = threading.Thread(target=_run, daemon=True, name=f"retrace-replay-{command.trace_id}")
    thread.start()
    return True


def parse_replay_message(msg: dict) -> Optional[ReplayCommand]:
    """Parse a WebSocket message into a ReplayCommand."""
    if msg.get("type") != "replay":
        return None
    data = msg.get("data", {})
    return ReplayCommand(
        trace_id=data.get("traceId", ""),
        trace_name=data.get("traceName", ""),
        input=data.get("input"),
        cassette=data.get("cassette", []),
    )
