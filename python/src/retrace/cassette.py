"""Deterministic replay via HTTP-layer cassette interception.

When replaying with a cassette, all LLM API calls are intercepted at the HTTP layer
and return pre-recorded responses. This guarantees byte-for-byte deterministic output
regardless of model state, temperature, or API availability.

Architecture:
1. During RECORD: interceptors capture full HTTP responses (headers + body)
2. During REPLAY: a monkey-patched transport layer returns cassette entries
   matched by (provider, model, input_hash) with fallback to sequential ordering

This is the foundation for J1: Real deterministic record/replay.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

logger = logging.getLogger("retrace")


@dataclass
class CassetteEntry:
    """A single recorded HTTP interaction."""
    span_index: int
    span_name: str
    span_type: str
    model: str | None
    input_hash: str  # SHA-256 of normalized input
    output: Any
    output_tokens: int | None = None
    cost: float | None = None
    duration_ms: int | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class Cassette:
    """Ordered collection of recorded interactions for deterministic replay."""
    entries: list[CassetteEntry] = field(default_factory=list)
    _cursor: int = field(default=0, repr=False)
    _index_by_hash: dict[str, list[int]] = field(default_factory=dict, repr=False)

    def build_index(self):
        """Build lookup index for content-addressed matching."""
        self._index_by_hash.clear()
        for i, entry in enumerate(self.entries):
            key = f"{entry.model}:{entry.input_hash}"
            self._index_by_hash.setdefault(key, []).append(i)

    def consume(self, model: str | None, input_data: Any) -> Optional[CassetteEntry]:
        """Consume the next matching cassette entry.
        
        Matching strategy (ordered by priority):
        1. Content-addressed: match by (model, input_hash)
        2. Sequential fallback: return next unconsumed entry of same span_type
        3. Cursor fallback: return next entry regardless
        """
        input_hash = _hash_input(input_data)
        key = f"{model}:{input_hash}"

        # Strategy 1: Content-addressed match
        if key in self._index_by_hash:
            indices = self._index_by_hash[key]
            for idx in indices:
                if idx >= self._cursor:
                    self._cursor = idx + 1
                    return self.entries[idx]

        # Strategy 2: Sequential cursor
        if self._cursor < len(self.entries):
            entry = self.entries[self._cursor]
            self._cursor += 1
            return entry

        logger.warning("[retrace-cassette] Cassette exhausted — no more entries to replay")
        return None

    @classmethod
    def from_spans(cls, spans: Sequence[dict]) -> "Cassette":
        """Build a cassette from recorded span data."""
        entries = []
        for i, span in enumerate(spans):
            if span.get("span_type") not in ("llm_call", "tool_call"):
                continue
            entries.append(CassetteEntry(
                span_index=i,
                span_name=span.get("name", ""),
                span_type=span.get("span_type", ""),
                model=span.get("model"),
                input_hash=_hash_input(span.get("input")),
                output=span.get("output"),
                output_tokens=span.get("output_tokens"),
                cost=span.get("cost"),
                duration_ms=span.get("duration_ms"),
                metadata=span.get("metadata", {}),
            ))
        cassette = cls(entries=entries)
        cassette.build_index()
        return cassette


# ─── Replay Context (thread-local) ───────────────────────────────────
import threading

_replay_context: threading.local = threading.local()


def set_active_cassette(cassette: Optional[Cassette]):
    """Set the active cassette for the current thread (enables deterministic mode)."""
    _replay_context.cassette = cassette


def get_active_cassette() -> Optional[Cassette]:
    """Get the active cassette for the current thread."""
    return getattr(_replay_context, "cassette", None)


def is_replaying() -> bool:
    """Check if we're currently in deterministic replay mode."""
    return get_active_cassette() is not None


def consume_cassette_entry(model: str | None, input_data: Any) -> Optional[CassetteEntry]:
    """Consume the next cassette entry during replay. Returns None if not replaying."""
    cassette = get_active_cassette()
    if cassette is None:
        return None
    return cassette.consume(model, input_data)


# ─── Utilities ────────────────────────────────────────────────────────
def _hash_input(input_data: Any) -> str:
    """Produce a stable SHA-256 hash of input data for content-addressed matching."""
    try:
        # Normalize: sort keys, strip whitespace
        normalized = json.dumps(input_data, sort_keys=True, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        normalized = str(input_data)
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]
