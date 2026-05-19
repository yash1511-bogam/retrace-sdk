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

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .resume import get_resumable

logger = logging.getLogger("retrace")

# Thread-local cassette state
_cassette_lock = threading.Lock()
_active_cassette: list[dict] | None = None
_cassette_pointer: int = 0


@dataclass
class ReplayCommand:
    """Command received from API to replay a trace with cassette."""
    trace_id: str
    trace_name: str
    input: Any
    cassette: list[dict]


def is_replaying() -> bool:
    """Check if a deterministic replay is currently active."""
    return _active_cassette is not None


def consume_cassette_entry(name: str, span_type: str) -> Optional[dict]:
    """Get the next cassette entry matching a span name and type.

    Uses sequential matching with name-based fallback for deterministic replay.
    Returns the full entry dict with 'output', 'error', etc. or None if not replaying.
    """
    global _cassette_pointer
    if _active_cassette is None:
        return None

    with _cassette_lock:
        # Primary: sequential pointer (deterministic order)
        if _cassette_pointer < len(_active_cassette):
            entry = _active_cassette[_cassette_pointer]
            if entry.get("name") == name and entry.get("span_type") == span_type:
                _cassette_pointer += 1
                return entry

        # Fallback: search by name + type from current pointer forward
        for i in range(_cassette_pointer, len(_active_cassette)):
            if _active_cassette[i].get("name") == name and _active_cassette[i].get("span_type") == span_type:
                _cassette_pointer = i + 1
                return _active_cassette[i]

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
        global _active_cassette, _cassette_pointer
        try:
            from .recorder import TraceRecorder
            from .trace import TraceStatus

            # Set up cassette
            _active_cassette = command.cassette
            _cassette_pointer = 0

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
            _active_cassette = None
            _cassette_pointer = 0

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
