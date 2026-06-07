"""Gemini interceptor for Retrace Python SDK."""
import time
import uuid

from ._dispatch import capture_active_emit, register_open_span, unregister_open_span
from .tool_spans import (
    emit_gemini_tool_calls,
    emit_gemini_tool_results,
    extract_sampling_params,
    extract_tool_schemas,
    reset_tool_result_dedup,
)

_original_generate = None
_original_async_generate = None
_original_stream = None
_original_async_stream = None
_installed = False
_on_span = None

PRICING = {
    # Gemini 3 series
    "gemini-3.1-flash-lite": (0.10, 0.40),
    "gemini-3.1-flash": (0.50, 3.0),
    "gemini-3-flash": (0.50, 3.0),
    "gemini-3-pro": (2.0, 12.0),
    "gemini-3.1-pro-preview": (2.0, 12.0),
    # Gemini 2.x
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.0-flash-lite": (0.05, 0.20),
}


def _calc_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = PRICING.get(model, (0, 0))
    return (input_tokens * p[0] + output_tokens * p[1]) / 1_000_000


def _extract_output_text(result) -> str:
    """Safely extract text from a Gemini response, handling function-call-only responses."""
    text = getattr(result, "text", None)
    if text is not None:
        from ..config import get_config
        limit = get_config().max_payload_size
        return text[:limit]
    # Function-call response — serialize the function call names
    candidates = getattr(result, "candidates", None)
    if candidates:
        parts = getattr(candidates[0].content, "parts", [])
        calls = [p.function_call.name for p in parts if getattr(p, "function_call", None)]
        if calls:
            return f"[function_call: {', '.join(calls)}]"
    return ""


def install_gemini_interceptor(on_span=None):
    global _original_generate, _original_async_generate, _installed, _on_span
    if _installed:
        if on_span:
            _on_span = on_span
        reset_tool_result_dedup()
        return

    try:
        from google import genai
    except ImportError:
        return

    _on_span = on_span
    reset_tool_result_dedup()
    _original_generate = genai.models.Models.generate_content

    def patched_generate(self, *args, **kwargs):
        from retrace.replay import consume_cassette_entry, is_replaying

        model = kwargs.get("model", args[0] if args else "unknown")
        contents = kwargs.get("contents", args[1] if len(args) > 1 else None)
        _cfg = kwargs.get("config") or (args[2] if len(args) > 2 else None)
        _cfg_tools = None
        if _cfg is not None:
            _cfg_tools = _cfg.get("tools") if isinstance(_cfg, dict) else getattr(_cfg, "tools", None)
        tool_schemas = extract_tool_schemas("gemini", _cfg_tools)
        sampling = extract_sampling_params("gemini", {"config": _cfg})
        span_id = str(uuid.uuid4())

        # Replay mode — return mocked response from cassette
        if is_replaying():
            entry = consume_cassette_entry("gemini.generate_content", "llm_call")
            if entry:
                from unittest.mock import MagicMock
                mock = MagicMock()
                mock.text = entry.get("output_raw") or entry.get("output", "")
                mock.usage_metadata.prompt_token_count = entry.get("input_tokens", 0)
                mock.usage_metadata.candidates_token_count = entry.get("output_tokens", 0)
                mock.candidates = []
                return mock

        start = time.time()

        try:
            result = _original_generate(self, *args, **kwargs)

            # Check if streaming response (has __iter__ but not a string)
            config_arg = kwargs.get("config") or (args[2] if len(args) > 2 else None)
            is_stream = getattr(config_arg, "stream", False) if config_arg else False

            if is_stream and hasattr(result, "__iter__") and not isinstance(result, (str, bytes)):
                # Wrap streaming response to capture after all chunks consumed
                def _stream_wrapper(stream, span_id, model, contents, start):
                    chunks = []
                    for chunk in stream:
                        chunks.append(chunk)
                        yield chunk
                    # After stream exhausted, report span
                    duration_ms = int((time.time() - start) * 1000)
                    full_text = "".join(getattr(c, "text", "") or "" for c in chunks)
                    if _on_span:
                        _on_span({
                            "id": span_id,
                            "span_type": "llm_call",
                            "name": "retrace.ai.generate",
                            "model": model,
                            "input": str(contents)[:2000] if contents else None,
                            "output": full_text[:2000],
                            "duration_ms": duration_ms,
                        })
                return _stream_wrapper(result, span_id, model, contents, start)

            duration_ms = int((time.time() - start) * 1000)
            input_tokens = getattr(getattr(result, "usage_metadata", None), "prompt_token_count", 0) or 0
            output_tokens = getattr(getattr(result, "usage_metadata", None), "candidates_token_count", 0) or 0

            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "retrace.ai.generate",
                    "model": model,
                    "input": str(contents)[:2000] if contents else None,
                    "output": _extract_output_text(result),
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": _calc_cost(model, input_tokens, output_tokens),
                    "duration_ms": duration_ms,
                    "metadata": {
                        **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                        **({"sampling": sampling} if sampling else {}),
                    } or None,
                })
                # Auto-capture tool usage (functionCall parts in response, functionResponse in input)
                emit_gemini_tool_results(contents, _on_span)
                emit_gemini_tool_calls(getattr(result, "candidates", None), span_id, model, _on_span)
            return result
        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            if _on_span:
                _on_span({
                    "id": span_id,
                    "span_type": "llm_call",
                    "name": "retrace.ai.generate",
                    "model": model,
                    "input": str(contents)[:2000] if contents else None,
                    "duration_ms": duration_ms,
                    "error": str(e),
                })
            raise

    genai.models.Models.generate_content = patched_generate

    # Streaming via the real API: generate_content_stream (NOT generate_content+stream flag). Two-phase
    # streaming-A (model (b)): open the span at invocation (registered with the active recorder in the
    # CALLER's context, emit target bound now) and emit ONCE at finalization. capture_complete is true
    # ONLY on an observed clean drain AND no function call (a function-call stream isn't text-captured
    # and the AFC path may re-issue → not byte-replay-eligible). Trace-end/atexit backstop closes any
    # abandoned stream partial.
    global _original_stream
    if _original_stream is None and hasattr(genai.models.Models, "generate_content_stream"):
        _original_stream = genai.models.Models.generate_content_stream

    if _original_stream is not None:
        def patched_generate_content_stream(self, *args, **kwargs):
            from retrace.replay import consume_cassette_entry, is_replaying
            model = kwargs.get("model", args[0] if args else "unknown")
            contents = kwargs.get("contents", args[1] if len(args) > 1 else None)
            _cfg = kwargs.get("config") or (args[2] if len(args) > 2 else None)
            _cfg_tools = (_cfg.get("tools") if isinstance(_cfg, dict) else getattr(_cfg, "tools", None)) if _cfg is not None else None
            tool_schemas = extract_tool_schemas("gemini", _cfg_tools)
            sampling = extract_sampling_params("gemini", {"config": _cfg})
            span_id = str(uuid.uuid4())
            start = time.time()

            if is_replaying():
                entry = consume_cassette_entry("gemini.generate_content", "llm_call")
                if entry:
                    def _mock():
                        from unittest.mock import MagicMock
                        m = MagicMock(); m.text = entry.get("output_raw") or entry.get("output", ""); yield m
                    return _mock()

            raw = _original_stream(self, *args, **kwargs)
            bound_emit = capture_active_emit() or _on_span
            st = {"chunks": [], "in_tok": 0, "out_tok": 0, "saw_fn": False, "last_candidates": None, "err": None, "emitted": False}

            def finalize(reason):
                if st["emitted"]:
                    return
                st["emitted"] = True
                unregister_open_span(span_id)
                complete = (reason == "complete") and not st["saw_fn"]
                text = "".join(st["chunks"])
                if not text and st["last_candidates"]:
                    parts = getattr(st["last_candidates"][0].content, "parts", []) or []
                    calls = [p.function_call.name for p in parts if getattr(p, "function_call", None)]
                    if calls:
                        text = f"[function_call: {', '.join(calls)}]"
                if bound_emit:
                    md = {"streaming": True, "capture_complete": complete}
                    if tool_schemas:
                        md["tool_schemas"] = tool_schemas
                    if sampling:
                        md["sampling"] = sampling
                    bound_emit({
                        "id": span_id, "span_type": "llm_call", "name": "retrace.ai.generate", "model": model,
                        "input": str(contents)[:2000] if contents else None, "output": text[:2000],
                        "input_tokens": st["in_tok"], "output_tokens": st["out_tok"],
                        "cost": _calc_cost(model, st["in_tok"], st["out_tok"]),
                        "duration_ms": int((time.time() - start) * 1000),
                        **({"error": st["err"]} if st["err"] else {}),
                        "metadata": md,
                    })
                    emit_gemini_tool_results(contents, bound_emit)
                    emit_gemini_tool_calls(st["last_candidates"], span_id, model, bound_emit)

            register_open_span(span_id, finalize)

            def wrapped():
                try:
                    for chunk in raw:
                        t = getattr(chunk, "text", None)
                        if isinstance(t, str):
                            st["chunks"].append(t)
                        cands = getattr(chunk, "candidates", None)
                        if cands:
                            st["last_candidates"] = cands
                            parts = getattr(cands[0].content, "parts", []) or []
                            if any(getattr(p, "function_call", None) for p in parts):
                                st["saw_fn"] = True
                        um = getattr(chunk, "usage_metadata", None)
                        if um:
                            st["in_tok"] = getattr(um, "prompt_token_count", 0) or st["in_tok"]
                            st["out_tok"] = getattr(um, "candidates_token_count", 0) or st["out_tok"]
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
            return wrapped()

        genai.models.Models.generate_content_stream = patched_generate_content_stream

    # Async client instrumentation (client.aio.models / AsyncModels).
    try:
        if _original_async_generate is None and hasattr(genai.models, "AsyncModels"):
            _original_async_generate = genai.models.AsyncModels.generate_content

        if _original_async_generate is not None:
            async def patched_async_generate(self, *args, **kwargs):
                from retrace.replay import consume_cassette_entry, is_replaying

                model = kwargs.get("model", args[0] if args else "unknown")
                contents = kwargs.get("contents", args[1] if len(args) > 1 else None)
                _cfg = kwargs.get("config") or (args[2] if len(args) > 2 else None)
                _cfg_tools = None
                if _cfg is not None:
                    _cfg_tools = _cfg.get("tools") if isinstance(_cfg, dict) else getattr(_cfg, "tools", None)
                tool_schemas = extract_tool_schemas("gemini", _cfg_tools)
                sampling = extract_sampling_params("gemini", {"config": _cfg})
                span_id = str(uuid.uuid4())

                if is_replaying():
                    entry = consume_cassette_entry("gemini.generate_content", "llm_call")
                    if entry:
                        from unittest.mock import MagicMock
                        mock = MagicMock()
                        mock.text = entry.get("output_raw") or entry.get("output", "")
                        mock.usage_metadata.prompt_token_count = entry.get("input_tokens", 0)
                        mock.usage_metadata.candidates_token_count = entry.get("output_tokens", 0)
                        mock.candidates = []
                        return mock

                start = time.time()
                try:
                    result = await _original_async_generate(self, *args, **kwargs)
                    duration_ms = int((time.time() - start) * 1000)
                    input_tokens = getattr(getattr(result, "usage_metadata", None), "prompt_token_count", 0) or 0
                    output_tokens = getattr(getattr(result, "usage_metadata", None), "candidates_token_count", 0) or 0
                    if _on_span:
                        _on_span({
                            "id": span_id,
                            "span_type": "llm_call",
                            "name": "retrace.ai.generate",
                            "model": model,
                            "input": str(contents)[:2000] if contents else None,
                            "output": _extract_output_text(result),
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "cost": _calc_cost(model, input_tokens, output_tokens),
                            "duration_ms": duration_ms,
                            "metadata": {
                                **({"tool_schemas": tool_schemas} if tool_schemas else {}),
                                **({"sampling": sampling} if sampling else {}),
                            } or None,
                        })
                        emit_gemini_tool_results(contents, _on_span)
                        emit_gemini_tool_calls(getattr(result, "candidates", None), span_id, model, _on_span)
                    return result
                except Exception as e:
                    duration_ms = int((time.time() - start) * 1000)
                    if _on_span:
                        _on_span({
                            "id": span_id,
                            "span_type": "llm_call",
                            "name": "retrace.ai.generate",
                            "model": model,
                            "input": str(contents)[:2000] if contents else None,
                            "duration_ms": duration_ms,
                            "error": str(e),
                        })
                    raise

            genai.models.AsyncModels.generate_content = patched_async_generate

        # Async streaming: AsyncModels.generate_content_stream (class method → retroactive, F-T2).
        # finalize() is fully SYNCHRONOUS (no await / no loop scheduling) so the sync atexit/SIGTERM
        # backstop can finalize an async-origin open span even after the event loop is torn down.
        global _original_async_stream
        if _original_async_stream is None and hasattr(genai.models, "AsyncModels") and hasattr(genai.models.AsyncModels, "generate_content_stream"):
            _original_async_stream = genai.models.AsyncModels.generate_content_stream

        if _original_async_stream is not None:
            async def patched_async_stream(self, *args, **kwargs):
                import inspect as _inspect
                from retrace.replay import consume_cassette_entry, is_replaying
                model = kwargs.get("model", args[0] if args else "unknown")
                contents = kwargs.get("contents", args[1] if len(args) > 1 else None)
                _cfg = kwargs.get("config") or (args[2] if len(args) > 2 else None)
                _cfg_tools = (_cfg.get("tools") if isinstance(_cfg, dict) else getattr(_cfg, "tools", None)) if _cfg is not None else None
                tool_schemas = extract_tool_schemas("gemini", _cfg_tools)
                sampling = extract_sampling_params("gemini", {"config": _cfg})
                span_id = str(uuid.uuid4())
                start = time.time()

                if is_replaying():
                    entry = consume_cassette_entry("gemini.generate_content", "llm_call")
                    if entry:
                        async def _amock():
                            from unittest.mock import MagicMock
                            m = MagicMock(); m.text = entry.get("output_raw") or entry.get("output", ""); yield m
                        return _amock()

                raw = _original_async_stream(self, *args, **kwargs)
                if _inspect.iscoroutine(raw):
                    raw = await raw  # some SDK builds return a coroutine resolving to the async iterator

                bound_emit = capture_active_emit() or _on_span
                st = {"chunks": [], "in_tok": 0, "out_tok": 0, "saw_fn": False, "last_candidates": None, "err": None, "emitted": False}

                def finalize(reason):  # SYNCHRONOUS — safe to call from the sync backstop with no loop
                    if st["emitted"]:
                        return
                    st["emitted"] = True
                    unregister_open_span(span_id)
                    complete = (reason == "complete") and not st["saw_fn"]
                    text = "".join(st["chunks"])
                    if not text and st["last_candidates"]:
                        parts = getattr(st["last_candidates"][0].content, "parts", []) or []
                        calls = [p.function_call.name for p in parts if getattr(p, "function_call", None)]
                        if calls:
                            text = f"[function_call: {', '.join(calls)}]"
                    if bound_emit:
                        md = {"streaming": True, "capture_complete": complete}
                        if tool_schemas:
                            md["tool_schemas"] = tool_schemas
                        if sampling:
                            md["sampling"] = sampling
                        bound_emit({
                            "id": span_id, "span_type": "llm_call", "name": "retrace.ai.generate", "model": model,
                            "input": str(contents)[:2000] if contents else None, "output": text[:2000],
                            "input_tokens": st["in_tok"], "output_tokens": st["out_tok"],
                            "cost": _calc_cost(model, st["in_tok"], st["out_tok"]),
                            "duration_ms": int((time.time() - start) * 1000),
                            **({"error": st["err"]} if st["err"] else {}),
                            "metadata": md,
                        })
                        emit_gemini_tool_results(contents, bound_emit)
                        emit_gemini_tool_calls(st["last_candidates"], span_id, model, bound_emit)

                register_open_span(span_id, finalize)

                async def wrapped():
                    try:
                        async for chunk in raw:
                            t = getattr(chunk, "text", None)
                            if isinstance(t, str):
                                st["chunks"].append(t)
                            cands = getattr(chunk, "candidates", None)
                            if cands:
                                st["last_candidates"] = cands
                                parts = getattr(cands[0].content, "parts", []) or []
                                if any(getattr(p, "function_call", None) for p in parts):
                                    st["saw_fn"] = True
                            um = getattr(chunk, "usage_metadata", None)
                            if um:
                                st["in_tok"] = getattr(um, "prompt_token_count", 0) or st["in_tok"]
                                st["out_tok"] = getattr(um, "candidates_token_count", 0) or st["out_tok"]
                            yield chunk
                        finalize("complete")
                    except GeneratorExit:
                        # NOTE: async early-break does NOT run this promptly — async generators are
                        # finalized by loop.shutdown_asyncgens()/GC (deferred), so the span is most
                        # often finalized partial here at loop-shutdown or by the atexit backstop, NOT
                        # at the break point. Correctness holds (still false, still captured); timing
                        # is deferred.
                        finalize("partial")
                        raise
                    except Exception as e:
                        st["err"] = str(e)
                        finalize("partial")
                        raise
                    finally:
                        finalize("partial")
                return wrapped()

            genai.models.AsyncModels.generate_content_stream = patched_async_stream
    except (ImportError, AttributeError):
        pass

    _installed = True


def uninstall_gemini_interceptor():
    global _installed, _on_span, _original_generate
    if not _installed or not _original_generate:
        return
    try:
        from google import genai
        genai.models.Models.generate_content = _original_generate
        if _original_stream is not None and hasattr(genai.models.Models, "generate_content_stream"):
            genai.models.Models.generate_content_stream = _original_stream
        if _original_async_generate is not None and hasattr(genai.models, "AsyncModels"):
            genai.models.AsyncModels.generate_content = _original_async_generate
        if _original_async_stream is not None and hasattr(genai.models, "AsyncModels") and hasattr(genai.models.AsyncModels, "generate_content_stream"):
            genai.models.AsyncModels.generate_content_stream = _original_async_stream
    except ImportError:
        pass
    _installed = False
    _on_span = None
