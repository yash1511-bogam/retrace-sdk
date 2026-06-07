"""OpenAI interceptor for Retrace Python SDK."""
import time
import uuid

from .tool_spans import (
    _parse_args,
    emit_openai_tool_calls,
    emit_openai_tool_results,
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
    # GPT-5.5 series
    "gpt-5.5-pro": (30.0, 180.0),
    "gpt-5.5": (5.0, 30.0),
    # GPT-5.4 series
    "gpt-5.4-pro": (15.0, 90.0),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.20),
    "gpt-5.4": (2.50, 15.0),
    # GPT-5 series
    "gpt-5-mini": (0.50, 3.0),
    "gpt-5-nano": (0.10, 0.60),
    "gpt-5": (1.25, 10.0),
    # GPT-4.1
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1": (2.0, 8.0),
    # Legacy
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.0),
    # Reasoning
    "o3": (10.0, 40.0),
    "o4-mini": (1.10, 4.40),
    "o3-mini": (1.10, 4.40),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    for key, p in PRICING.items():
        if key in model:
            return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000
    return 0.0


def _wrap_stream(stream, span_id, model, messages, start, tool_schemas=None, sampling=None):
    """Wrap a streaming response to collect chunks and emit a span on completion."""
    chunks = []
    tool_acc: dict[int, dict] = {}
    st = {"in_tok": 0, "out_tok": 0, "emitted": False}
    # Capture the active recorder sink NOW (the trace context is alive at stream start). A stream
    # finalized AFTER its trace context exits (GeneratorExit during GC / interpreter atexit) would
    # otherwise resolve the dispatcher ContextVar to None and silently DROP the span. Binding the
    # emit here + registering a trace-end backstop guarantees the span is captured (parity w/ Gemini/TS).
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
                "name": "openai.chat.completions.create",
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
                    **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                    **({"sampling": sampling} if sampling else {}),
                },
            })
            emit_openai_tool_results(messages, bound_emit)
            acc_msg = {"tool_calls": [
                {"id": t["id"], "function": {"name": t["name"], "arguments": _parse_args(t["args"])}}
                for t in tool_acc.values()
            ]}
            emit_openai_tool_calls(acc_msg, span_id, model, bound_emit)

    register_open_span(span_id, finalize)

    def _gen():
        try:
            for chunk in stream:
                _ch = chunk.choices[0] if hasattr(chunk, "choices") and chunk.choices else None
                delta = getattr(getattr(_ch, "delta", None), "content", None)
                if delta:
                    chunks.append(delta)
                # Accumulate streamed tool-call fragments by index
                _ch_tc = chunk.choices[0] if hasattr(chunk, "choices") and chunk.choices else None
                tcs = getattr(getattr(_ch_tc, "delta", None), "tool_calls", None)
                if tcs:
                    for tc in tcs:
                        idx = getattr(tc, "index", 0) or 0
                        acc = tool_acc.setdefault(idx, {"id": None, "name": None, "args": ""})
                        if getattr(tc, "id", None):
                            acc["id"] = tc.id
                        fn = getattr(tc, "function", None)
                        if getattr(fn, "name", None):
                            acc["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            acc["args"] += fn.arguments
                usage = getattr(chunk, "usage", None)
                if usage:
                    st["in_tok"] = getattr(usage, "prompt_tokens", 0) or 0
                    st["out_tok"] = getattr(usage, "completion_tokens", 0) or 0
                yield chunk
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


def _wrap_async_stream(stream, span_id, model, messages, start, tool_schemas=None, sampling=None):
    """Async counterpart of _wrap_stream — collects chunks from an async stream + emits a span."""
    chunks = []
    tool_acc: dict[int, dict] = {}
    st = {"in_tok": 0, "out_tok": 0, "emitted": False}
    # Bind the active sink + register a trace-end backstop (see _wrap_stream): an async stream
    # finalized after its trace context exits must still emit, not silently drop the span.
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
                "name": "openai.chat.completions.create",
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
                    **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                    **({"sampling": sampling} if sampling else {}),
                },
            })
            emit_openai_tool_results(messages, bound_emit)
            acc_msg = {"tool_calls": [
                {"id": t["id"], "function": {"name": t["name"], "arguments": _parse_args(t["args"])}}
                for t in tool_acc.values()
            ]}
            emit_openai_tool_calls(acc_msg, span_id, model, bound_emit)

    register_open_span(span_id, finalize)

    async def _agen():
        try:
            async for chunk in stream:
                _ch = chunk.choices[0] if hasattr(chunk, "choices") and chunk.choices else None
                delta = getattr(getattr(_ch, "delta", None), "content", None)
                if delta:
                    chunks.append(delta)
                tcs = getattr(getattr(_ch, "delta", None), "tool_calls", None)
                if tcs:
                    for tc in tcs:
                        idx = getattr(tc, "index", 0) or 0
                        acc = tool_acc.setdefault(idx, {"id": None, "name": None, "args": ""})
                        if getattr(tc, "id", None):
                            acc["id"] = tc.id
                        fn = getattr(tc, "function", None)
                        if getattr(fn, "name", None):
                            acc["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            acc["args"] += fn.arguments
                usage = getattr(chunk, "usage", None)
                if usage:
                    st["in_tok"] = getattr(usage, "prompt_tokens", 0) or 0
                    st["out_tok"] = getattr(usage, "completion_tokens", 0) or 0
                yield chunk
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


def install_openai_interceptor(on_span=None):
    global _original_create, _original_async_create, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        reset_tool_result_dedup()
        return

    try:
        from openai.resources.chat.completions import Completions
    except ImportError:
        return

    _on_span = on_span
    reset_tool_result_dedup()
    _original_create = Completions.create

    def patched_create(self, *args, **kwargs):
        from retrace.replay import consume_cassette_entry, is_replaying

        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        is_streaming = kwargs.get("stream", False)
        response_format = kwargs.get("response_format", None)
        tool_schemas = extract_tool_schemas("openai", kwargs.get("tools"))
        sampling = extract_sampling_params("openai", kwargs)
        span_id = str(uuid.uuid4())

        # Detect vision (image_url content parts) and structured output
        has_vision = any(
            isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m["content"])
            for m in messages if isinstance(m, dict)
        )
        span_metadata = {}
        if has_vision:
            span_metadata["vision"] = True
        if response_format:
            span_metadata["structured_output"] = (
                response_format.get("type", "json_schema") if isinstance(response_format, dict)
                else getattr(response_format, "type", str(response_format))
            )

        # Replay mode — return mocked response from cassette
        if is_replaying():
            entry = consume_cassette_entry("openai.chat.completions.create", "llm_call")
            if entry:
                from unittest.mock import MagicMock
                mock = MagicMock()
                mock.choices = [MagicMock()]
                mock.choices[0].message.content = entry.get("output_raw") or entry.get("output", "")
                mock.choices[0].message.role = "assistant"
                mock.usage.prompt_tokens = entry.get("input_tokens", 0)
                mock.usage.completion_tokens = entry.get("output_tokens", 0)
                return mock

        start = time.time()

        try:
            result = _original_create(self, *args, **kwargs)

            # Streaming response: wrap the iterator to collect chunks
            if is_streaming and hasattr(result, "__iter__"):
                return _wrap_stream(result, span_id, model, messages, start, tool_schemas, sampling)

            duration_ms = int((time.time() - start) * 1000)
            usage = getattr(result, "usage", None)
            input_tokens = getattr(usage, "prompt_tokens", 0) or 0
            output_tokens = getattr(usage, "completion_tokens", 0) or 0
            output = ""
            msg = None
            if hasattr(result, "choices") and result.choices:
                msg = result.choices[0].message
                output = getattr(msg, "content", "") or ""

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "openai.chat.completions.create",
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
                # Auto-capture tool usage (tool_result from fed-back messages, tool_call from response)
                emit_openai_tool_results(messages, _on_span)
                emit_openai_tool_calls(msg, span_id, model, _on_span)
            return result
        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "openai.chat.completions.create",
                    "model": model,
                    "input": {"messages": [
                        {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                        for m in messages[:10]
                    ]},
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    Completions.create = patched_create

    # Async client instrumentation (AsyncOpenAI). Without this, async users record nothing
    # while the README promises auto-capture.
    try:
        from openai.resources.chat.completions import AsyncCompletions
        if _original_async_create is None:
            _original_async_create = AsyncCompletions.create

        async def patched_async_create(self, *args, **kwargs):
            from retrace.replay import consume_cassette_entry, is_replaying

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])
            is_streaming = kwargs.get("stream", False)
            tool_schemas = extract_tool_schemas("openai", kwargs.get("tools"))
            sampling = extract_sampling_params("openai", kwargs)
            span_id = str(uuid.uuid4())

            if is_replaying():
                entry = consume_cassette_entry("openai.chat.completions.create", "llm_call")
                if entry:
                    from unittest.mock import MagicMock
                    mock = MagicMock()
                    mock.choices = [MagicMock()]
                    mock.choices[0].message.content = entry.get("output_raw") or entry.get("output", "")
                    mock.choices[0].message.role = "assistant"
                    mock.usage.prompt_tokens = entry.get("input_tokens", 0)
                    mock.usage.completion_tokens = entry.get("output_tokens", 0)
                    return mock

            start = time.time()
            try:
                result = await _original_async_create(self, *args, **kwargs)
                if is_streaming and hasattr(result, "__aiter__"):
                    return _wrap_async_stream(result, span_id, model, messages, start, tool_schemas, sampling)
                duration_ms = int((time.time() - start) * 1000)
                usage = getattr(result, "usage", None)
                input_tokens = getattr(usage, "prompt_tokens", 0) or 0
                output_tokens = getattr(usage, "completion_tokens", 0) or 0
                output = ""
                msg = None
                if hasattr(result, "choices") and result.choices:
                    msg = result.choices[0].message
                    output = getattr(msg, "content", "") or ""
                if _on_span:
                    _on_span({
                        "id": span_id,
                        "span_type": "llm_call",
                        "name": "openai.chat.completions.create",
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
                    emit_openai_tool_results(messages, _on_span)
                    emit_openai_tool_calls(msg, span_id, model, _on_span)
                return result
            except Exception as e:
                duration_ms = int((time.time() - start) * 1000)
                if _on_span:
                    _on_span({
                        "id": span_id,
                        "span_type": "llm_call",
                        "name": "openai.chat.completions.create",
                        "model": model,
                        "input": {"messages": [
                            {"role": m.get("role", ""), "content": str(m.get("content", ""))[:1000]}
                            for m in messages[:10]
                        ]},
                        "duration_ms": duration_ms,
                        "error": str(e),
                    })
                raise

        AsyncCompletions.create = patched_async_create
    except ImportError:
        pass

    _installed = True


def uninstall_openai_interceptor():
    global _installed, _on_span, _original_create
    if not _installed or not _original_create:
        return
    try:
        from openai.resources.chat.completions import Completions
        Completions.create = _original_create
    except ImportError:
        pass
    try:
        if _original_async_create is not None:
            from openai.resources.chat.completions import AsyncCompletions
            AsyncCompletions.create = _original_async_create
    except ImportError:
        pass
    _installed = False
    _on_span = None
