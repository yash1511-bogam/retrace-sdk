"""Anthropic interceptor for Retrace Python SDK."""
import time
import uuid

from .tool_spans import (
    _parse_args,
    emit_anthropic_tool_calls,
    emit_anthropic_tool_results,
    extract_sampling_params,
    extract_tool_schemas,
    reset_tool_result_dedup,
)
from ._dispatch import capture_active_emit, register_open_span, unregister_open_span

_original_create = None
_original_async_create = None
_installed = False
_on_span = None

PRICING = {
    # Opus
    "claude-opus-4.7": (5.0, 25.0),
    "claude-opus-4.6": (5.0, 25.0),
    # Sonnet
    "claude-sonnet-4.6": (3.0, 15.0),
    "claude-sonnet-4": (3.0, 15.0),
    # Haiku
    "claude-haiku-4.5": (1.0, 5.0),
    # Legacy
    "claude-3-7-sonnet": (3.0, 15.0),
    "claude-3-5-sonnet": (3.0, 15.0),
    "claude-3-5-haiku": (0.80, 4.0),
    "claude-3-opus": (15.0, 75.0),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    for key, p in PRICING.items():
        if key in model:
            return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000
    return 0.0


def _wrap_anthropic_stream(stream, span_id, model, messages, start):
    """Wrap Anthropic streaming response to collect text deltas and emit span."""
    chunks = []
    tool_acc: dict[int, dict] = {}
    st = {"in_tok": 0, "out_tok": 0, "emitted": False}
    # Bind the active sink + register a trace-end backstop: a stream finalized after its trace
    # context exits must still emit, not silently drop the span (parity with Gemini/TS).
    bound_emit = capture_active_emit() or _on_span

    def finalize(reason):
        if st["emitted"]:
            return
        st["emitted"] = True
        unregister_open_span(span_id)
        complete = reason == "complete"
        output = "".join(chunks)
        if bound_emit:
            bound_emit({
                "id": span_id,
                "span_type": "llm_call",
                "name": "anthropic.messages.create",
                "model": model,
                "input": {"messages": [
                    {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                    for m in messages[:10]
                ]},
                "output": output[:2000],
                "input_tokens": st["in_tok"],
                "output_tokens": st["out_tok"],
                "cost": _calc_cost(model, st["in_tok"], st["out_tok"]),
                "duration_ms": int((time.time() - start) * 1000),
                **({"error": st["err"]} if st.get("err") else {}),
                "metadata": {
                    "streaming": True,
                    "truncated": len(output) > 2000,
                    "capture_complete": complete,
                    **({} if complete else {"partial": True}),
                },
            })
            emit_anthropic_tool_results(messages, bound_emit)
            blocks = [
                {"type": "tool_use", "id": t["id"], "name": t["name"], "input": _parse_args(t["json"])}
                for t in tool_acc.values()
            ]
            emit_anthropic_tool_calls(blocks, span_id, model, bound_emit)

    register_open_span(span_id, finalize)

    def _gen():
        try:
            for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "content_block_delta":
                    delta = getattr(getattr(event, "delta", None), "text", None)
                    if delta:
                        chunks.append(delta)
                    # tool_use arguments stream as input_json_delta
                    djson = getattr(getattr(event, "delta", None), "partial_json", None)
                    if djson is not None:
                        acc = tool_acc.get(getattr(event, "index", 0) or 0)
                        if acc is not None:
                            acc["json"] += djson
                elif event_type == "content_block_start":
                    block = getattr(event, "content_block", None)
                    if getattr(block, "type", None) == "tool_use":
                        idx = getattr(event, "index", 0) or 0
                        tool_acc[idx] = {
                            "id": getattr(block, "id", None),
                            "name": getattr(block, "name", None), "json": "",
                        }
                elif event_type == "message_start":
                    msg = getattr(event, "message", None)
                    if msg and hasattr(msg, "usage"):
                        st["in_tok"] = getattr(msg.usage, "input_tokens", 0) or 0
                elif event_type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        st["out_tok"] = getattr(usage, "output_tokens", 0) or 0
                yield event
            finalize("complete")
        except GeneratorExit:
            finalize("partial")
            raise
        except Exception as e:
            st["err"] = str(e)
            finalize("partial")
            raise
        finally:
            finalize("partial")

    return _gen()


def _wrap_anthropic_async_stream(stream, span_id, model, messages, start):
    """Async counterpart of _wrap_anthropic_stream."""
    chunks = []
    tool_acc: dict[int, dict] = {}
    st = {"in_tok": 0, "out_tok": 0, "emitted": False}
    bound_emit = capture_active_emit() or _on_span

    def finalize(reason):
        if st["emitted"]:
            return
        st["emitted"] = True
        unregister_open_span(span_id)
        complete = reason == "complete"
        output = "".join(chunks)
        if bound_emit:
            bound_emit({
                "id": span_id,
                "span_type": "llm_call",
                "name": "anthropic.messages.create",
                "model": model,
                "input": {"messages": [
                    {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                    for m in messages[:10]
                ]},
                "output": output[:2000],
                "input_tokens": st["in_tok"],
                "output_tokens": st["out_tok"],
                "cost": _calc_cost(model, st["in_tok"], st["out_tok"]),
                "duration_ms": int((time.time() - start) * 1000),
                **({"error": st["err"]} if st.get("err") else {}),
                "metadata": {
                    "streaming": True,
                    "truncated": len(output) > 2000,
                    "capture_complete": complete,
                    **({} if complete else {"partial": True}),
                },
            })
            emit_anthropic_tool_results(messages, bound_emit)
            blocks = [
                {"type": "tool_use", "id": t["id"], "name": t["name"], "input": _parse_args(t["json"])}
                for t in tool_acc.values()
            ]
            emit_anthropic_tool_calls(blocks, span_id, model, bound_emit)

    register_open_span(span_id, finalize)

    async def _agen():
        try:
            async for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "content_block_delta":
                    delta = getattr(getattr(event, "delta", None), "text", None)
                    if delta:
                        chunks.append(delta)
                    djson = getattr(getattr(event, "delta", None), "partial_json", None)
                    if djson is not None:
                        acc = tool_acc.get(getattr(event, "index", 0) or 0)
                        if acc is not None:
                            acc["json"] += djson
                elif event_type == "content_block_start":
                    block = getattr(event, "content_block", None)
                    if getattr(block, "type", None) == "tool_use":
                        idx = getattr(event, "index", 0) or 0
                        tool_acc[idx] = {
                            "id": getattr(block, "id", None),
                            "name": getattr(block, "name", None), "json": "",
                        }
                elif event_type == "message_start":
                    msg = getattr(event, "message", None)
                    if msg and hasattr(msg, "usage"):
                        st["in_tok"] = getattr(msg.usage, "input_tokens", 0) or 0
                elif event_type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        st["out_tok"] = getattr(usage, "output_tokens", 0) or 0
                yield event
            finalize("complete")
        except GeneratorExit:
            finalize("partial")
            raise
        except Exception as e:
            st["err"] = str(e)
            finalize("partial")
            raise
        finally:
            finalize("partial")

    return _agen()


def install_anthropic_interceptor(on_span=None):
    global _original_create, _original_async_create, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        reset_tool_result_dedup()
        return

    try:
        from anthropic.resources.messages import Messages
    except ImportError:
        return

    _on_span = on_span
    reset_tool_result_dedup()
    _original_create = Messages.create

    def patched_create(self, *args, **kwargs):
        from retrace.replay import consume_cassette_entry, is_replaying

        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        is_streaming = kwargs.get("stream", False)
        tool_schemas = extract_tool_schemas("anthropic", kwargs.get("tools"))
        sampling = extract_sampling_params("anthropic", kwargs)
        span_id = str(uuid.uuid4())

        # Replay mode — return mocked response from cassette
        if is_replaying():
            entry = consume_cassette_entry("anthropic.messages.create", "llm_call")
            if entry:
                from unittest.mock import MagicMock
                mock = MagicMock()
                mock.content = [MagicMock()]
                mock.content[0].text = entry.get("output_raw") or entry.get("output", "")
                mock.content[0].type = "text"
                mock.usage.input_tokens = entry.get("input_tokens", 0)
                mock.usage.output_tokens = entry.get("output_tokens", 0)
                mock.model = model
                mock.role = "assistant"
                return mock

        start = time.time()

        try:
            result = _original_create(self, *args, **kwargs)

            # Streaming: wrap iterator to collect chunks and emit span on completion
            if is_streaming and hasattr(result, "__iter__"):
                return _wrap_anthropic_stream(result, span_id, model, messages, start)

            duration_ms = int((time.time() - start) * 1000)
            usage = getattr(result, "usage", None)
            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0
            output = ""
            if hasattr(result, "content") and result.content:
                output = getattr(result.content[0], "text", "") if result.content else ""

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "anthropic.messages.create",
                    "model": model,
                    "input": {"messages": [
                        {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                        for m in messages[:10]
                    ]},
                    "output": output[:2000],
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": _calc_cost(model, input_tokens, output_tokens),
                    "duration_ms": duration_ms,
                    "metadata": {
                        **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                        **({"sampling": sampling} if sampling else {}),
                        **({"truncated": True} if len(output) > 2000 else {}),
                    } or None,
                })
                # Auto-capture tool usage (tool_use blocks in response, tool_result in input)
                emit_anthropic_tool_results(messages, _on_span)
                emit_anthropic_tool_calls(getattr(result, "content", None), span_id, model, _on_span)
            return result
        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "anthropic.messages.create",
                    "model": model,
                    "input": {"messages": [
                        {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                        for m in messages[:10]
                    ]},
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    Messages.create = patched_create

    # Async client instrumentation (AsyncAnthropic).
    try:
        from anthropic.resources.messages import AsyncMessages
        if _original_async_create is None:
            _original_async_create = AsyncMessages.create

        async def patched_async_create(self, *args, **kwargs):
            from retrace.replay import consume_cassette_entry, is_replaying

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])
            is_streaming = kwargs.get("stream", False)
            tool_schemas = extract_tool_schemas("anthropic", kwargs.get("tools"))
            sampling = extract_sampling_params("anthropic", kwargs)
            span_id = str(uuid.uuid4())

            if is_replaying():
                entry = consume_cassette_entry("anthropic.messages.create", "llm_call")
                if entry:
                    from unittest.mock import MagicMock
                    mock = MagicMock()
                    mock.content = [MagicMock()]
                    mock.content[0].text = entry.get("output_raw") or entry.get("output", "")
                    mock.content[0].type = "text"
                    mock.usage.input_tokens = entry.get("input_tokens", 0)
                    mock.usage.output_tokens = entry.get("output_tokens", 0)
                    mock.model = model
                    mock.role = "assistant"
                    return mock

            start = time.time()
            try:
                result = await _original_async_create(self, *args, **kwargs)
                if is_streaming and hasattr(result, "__aiter__"):
                    return _wrap_anthropic_async_stream(result, span_id, model, messages, start)
                duration_ms = int((time.time() - start) * 1000)
                usage = getattr(result, "usage", None)
                input_tokens = getattr(usage, "input_tokens", 0) or 0
                output_tokens = getattr(usage, "output_tokens", 0) or 0
                output = ""
                if hasattr(result, "content") and result.content:
                    output = getattr(result.content[0], "text", "") if result.content else ""
                if _on_span:
                    _on_span({
                        "id": span_id,
                        "span_type": "llm_call",
                        "name": "anthropic.messages.create",
                        "model": model,
                        "input": {"messages": [
                            {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                            for m in messages[:10]
                        ]},
                        "output": output[:2000],
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "cost": _calc_cost(model, input_tokens, output_tokens),
                        "duration_ms": duration_ms,
                        "metadata": {
                            **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                            **({"sampling": sampling} if sampling else {}),
                        } or None,
                    })
                    emit_anthropic_tool_results(messages, _on_span)
                    emit_anthropic_tool_calls(getattr(result, "content", None), span_id, model, _on_span)
                return result
            except Exception as e:
                duration_ms = int((time.time() - start) * 1000)
                if _on_span:
                    _on_span({
                        "id": span_id,
                        "span_type": "llm_call",
                        "name": "anthropic.messages.create",
                        "model": model,
                        "input": {"messages": [
                            {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                            for m in messages[:10]
                        ]},
                        "duration_ms": duration_ms,
                        "error": str(e),
                    })
                raise

        AsyncMessages.create = patched_async_create
    except ImportError:
        pass

    _installed = True


def uninstall_anthropic_interceptor():
    global _installed, _on_span, _original_create
    if not _installed or not _original_create:
        return
    try:
        from anthropic.resources.messages import Messages
        Messages.create = _original_create
    except ImportError:
        pass
    try:
        if _original_async_create is not None:
            from anthropic.resources.messages import AsyncMessages
            AsyncMessages.create = _original_async_create
    except ImportError:
        pass
    _installed = False
    _on_span = None
