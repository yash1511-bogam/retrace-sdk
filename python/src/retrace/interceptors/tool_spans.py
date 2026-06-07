"""Tool-span extraction (Phase 1C) for the Retrace Python SDK.

Provider interceptors historically emitted only a single ``llm_call`` span and dropped the
model's tool calls (the most common agent-failure class). These helpers derive structured
``tool_call`` and ``tool_result`` spans from a provider request/response so tool usage is
captured with no manual instrumentation:

- ``tool_call`` spans come from the model response (the calls it requested), arguments parsed
  into structured JSON.
- ``tool_result`` spans come from the tool outputs fed back on the next request (verbatim,
  including errors/empty), deduped by the provider tool-call id.

Downstream detectors (schema validation, loop detection, tool-output hallucination) rely on
these spans + the ``tool_call_id`` carried in metadata.
"""
import json
import uuid
from datetime import datetime, timezone

# Bounded dedup of emitted tool_result spans (keyed by provider tool-call id). Reset when a new
# trace installs its callback so memory stays bounded.
_emitted_tool_result_ids: set[str] = set()


def reset_tool_result_dedup() -> None:
    _emitted_tool_result_ids.clear()


def _mark_emitted(key: str) -> bool:
    if key in _emitted_tool_result_ids:
        return False
    if len(_emitted_tool_result_ids) > 5000:
        _emitted_tool_result_ids.clear()
    _emitted_tool_result_ids.add(key)
    return True


def _get(obj, key, default=None):
    """Read an attribute from either a dict or an SDK object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _parse_args(args):
    if isinstance(args, str):
        try:
            return json.loads(args)
        except (ValueError, TypeError):
            return args
    return args


def extract_tool_schemas(provider: str, tools):
    """Extract declared tool parameter schemas (name → JSON schema) from a request's tools."""
    out: dict = {}
    if provider == "gemini":
        if not isinstance(tools, (list, tuple)):
            return None
        for group in tools:
            decls = _get(group, "function_declarations") or _get(group, "functionDeclarations") or []
            for fd in decls:
                name, params = _get(fd, "name"), _get(fd, "parameters")
                if name and params:
                    out[name] = params
    elif isinstance(tools, (list, tuple)):
        for t in tools:
            if provider == "openai":
                fn = _get(t, "function")
                name, params = _get(fn, "name"), _get(fn, "parameters")
                if name and params:
                    out[name] = params
            elif provider == "anthropic":
                name, schema = _get(t, "name"), _get(t, "input_schema")
                if name and schema:
                    out[name] = schema
    return out or None


def extract_sampling_params(provider: str, kwargs):
    """Capture the sampling/determinism envelope so replay-divergence (2A) + regression (2E) can
    compare sampling config, not just the model. Normalizes to
    {temperature, top_p, top_k, seed, max_tokens}. Returns None if none set."""
    cfg = _get(kwargs, "config") or {} if provider == "gemini" else (kwargs or {})
    out: dict = {}

    def put(k, v):
        if v is not None:
            out[k] = v

    if provider == "gemini":
        put("temperature", _get(cfg, "temperature"))
        put("top_p", _get(cfg, "top_p") or _get(cfg, "topP"))
        put("top_k", _get(cfg, "top_k") or _get(cfg, "topK"))
        put("seed", _get(cfg, "seed"))
        put("max_tokens", _get(cfg, "max_output_tokens") or _get(cfg, "maxOutputTokens"))
    else:
        put("temperature", _get(cfg, "temperature"))
        put("top_p", _get(cfg, "top_p"))
        put("top_k", _get(cfg, "top_k"))
        put("seed", _get(cfg, "seed"))
        put("max_tokens", _get(cfg, "max_tokens") or _get(cfg, "max_completion_tokens"))
    return out or None


def _truncate(val, limit: int = 4000):
    """Cap large string payloads; structured values are stored as-is (server uses jsonb)."""
    if isinstance(val, str):
        return val[:limit]
    return val


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _tool_call_span(name, args, parent_id, model, tool_call_id=None) -> dict:
    now = _now_iso()
    d = {
        "id": str(uuid.uuid4()),
        "span_type": "tool_call",
        "name": name or "tool",
        "parent_id": parent_id,
        "input": _truncate(args),
        "started_at": now,
        "ended_at": now,
        "duration_ms": 0,
    }
    if model:
        d["model"] = model
    if tool_call_id:
        d["metadata"] = {"tool_call_id": tool_call_id}
    return d


def _tool_result_span(name, output, is_error, tool_call_id=None) -> dict:
    now = _now_iso()
    d = {
        "id": str(uuid.uuid4()),
        "span_type": "tool_result",
        "name": name or "tool_result",
        "output": _truncate(output),
        "started_at": now,
        "ended_at": now,
        "duration_ms": 0,
    }
    if is_error:
        d["error"] = output if isinstance(output, str) else json.dumps(output, default=str)
    if tool_call_id:
        d["metadata"] = {"tool_call_id": tool_call_id}
    return d


# ─── OpenAI ───────────────────────────────────────────────────────────────────
def emit_openai_tool_calls(message, parent_id, model, emit) -> None:
    calls = _get(message, "tool_calls")
    if not calls:
        return
    for c in calls:
        fn = _get(c, "function")
        emit(_tool_call_span(
            _get(fn, "name") or "tool", _parse_args(_get(fn, "arguments")),
            parent_id, model, _get(c, "id"),
        ))


def emit_openai_tool_results(messages, emit) -> None:
    if not isinstance(messages, (list, tuple)):
        return
    name_by_id: dict[str, str] = {}
    for m in messages:
        if _get(m, "role") == "assistant":
            for c in (_get(m, "tool_calls") or []):
                cid = _get(c, "id")
                if cid:
                    name_by_id[cid] = _get(_get(c, "function"), "name") or "tool"
    for m in messages:
        if _get(m, "role") != "tool":
            continue
        cid = _get(m, "tool_call_id")
        if not cid or not _mark_emitted(f"oa:{cid}"):
            continue
        content = _get(m, "content")
        is_error = isinstance(content, str) and any(w in content.lower() for w in ("error", "exception", "failed"))
        emit(_tool_result_span(name_by_id.get(cid) or _get(m, "name") or "tool_result", content, is_error, cid))


# ─── Anthropic ─────────────────────────────────────────────────────────────────
def emit_anthropic_tool_calls(content, parent_id, model, emit) -> None:
    if not isinstance(content, (list, tuple)):
        return
    for block in content:
        if _get(block, "type") != "tool_use":
            continue
        emit(_tool_call_span(_get(block, "name") or "tool", _get(block, "input"), parent_id, model, _get(block, "id")))


def emit_anthropic_tool_results(messages, emit) -> None:
    if not isinstance(messages, (list, tuple)):
        return
    for m in messages:
        content = _get(m, "content")
        if not isinstance(content, (list, tuple)):
            continue
        for block in content:
            if _get(block, "type") != "tool_result":
                continue
            tid = _get(block, "tool_use_id")
            if not tid or not _mark_emitted(f"anthropic:{tid}"):
                continue
            emit(_tool_result_span("tool_result", _get(block, "content"), bool(_get(block, "is_error")), tid))


# ─── Gemini ────────────────────────────────────────────────────────────────────
def emit_gemini_tool_calls(candidates, parent_id, model, emit) -> None:
    if not isinstance(candidates, (list, tuple)):
        return
    for cand in candidates:
        parts = _get(_get(cand, "content"), "parts") or []
        for p in parts:
            fc = _get(p, "function_call")
            if not fc:
                continue
            emit(_tool_call_span(_get(fc, "name") or "tool", _get(fc, "args"), parent_id, model, _get(fc, "name")))


def emit_gemini_tool_results(contents, emit) -> None:
    if contents is None:
        return
    items = contents if isinstance(contents, (list, tuple)) else [contents]
    for c in items:
        parts = _get(c, "parts")
        if not isinstance(parts, (list, tuple)):
            continue
        for p in parts:
            fr = _get(p, "function_response")
            if not fr:
                continue
            name = _get(fr, "name")
            resp = _get(fr, "response")
            key = f"gemini:{_get(fr, 'id') or name or str(resp)[:64]}"
            if not _mark_emitted(key):
                continue
            emit(_tool_result_span(name or "tool_result", resp, False, _get(fr, "id") or name))
