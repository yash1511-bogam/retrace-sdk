from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional
from enum import Enum

from .utils import gen_id, utcnow


class SpanType(str, Enum):
    LLM_CALL = "llm_call"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    REASONING = "reasoning"
    ACTION = "action"
    ERROR = "error"
    FORK_POINT = "fork_point"


class TraceStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Span:
    id: str = field(default_factory=gen_id)
    trace_id: str = ""
    span_type: SpanType = SpanType.LLM_CALL
    name: str = ""
    parent_id: Optional[str] = None
    model: Optional[str] = None
    input: Any = None
    output: Any = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost: Optional[float] = None
    duration_ms: Optional[int] = None
    metadata: dict = field(default_factory=dict)
    started_at: Optional[datetime] = field(default_factory=utcnow)
    ended_at: Optional[datetime] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id,
            "trace_id": self.trace_id,
            "parent_id": self.parent_id,
            "span_type": self.span_type.value,
            "name": self.name,
            "started_at": self.started_at.isoformat().replace("+00:00", "Z") if self.started_at else None,
        }
        if self.model:
            d["model"] = self.model
        if self.input is not None:
            d["input"] = self.input
        if self.output is not None:
            d["output"] = self.output
        if self.input_tokens is not None:
            d["input_tokens"] = self.input_tokens
        if self.output_tokens is not None:
            d["output_tokens"] = self.output_tokens
        if self.cost is not None:
            d["cost"] = self.cost
        if self.duration_ms is not None:
            d["duration_ms"] = self.duration_ms
        if self.metadata:
            d["metadata"] = self.metadata
        if self.ended_at:
            d["ended_at"] = self.ended_at.isoformat().replace("+00:00", "Z")
        if self.error:
            d["error"] = self.error
        return d


@dataclass
class Trace:
    id: str = field(default_factory=gen_id)
    name: Optional[str] = None
    input: Any = None
    output: Any = None
    status: TraceStatus = TraceStatus.RUNNING
    total_tokens: int = 0
    total_cost: float = 0.0
    total_duration_ms: int = 0
    metadata: dict = field(default_factory=dict)
    started_at: Optional[datetime] = field(default_factory=utcnow)
    ended_at: Optional[datetime] = None
    spans: list = field(default_factory=list)
    project_id: Optional[str] = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "id": self.id,
            "status": self.status.value,
            "total_tokens": self.total_tokens,
            "total_cost": self.total_cost,
            "total_duration_ms": self.total_duration_ms,
            "started_at": self.started_at.isoformat().replace("+00:00", "Z") if self.started_at else None,
        }
        if self.name:
            d["name"] = self.name
        if self.input is not None:
            d["input"] = self.input
        if self.output is not None:
            d["output"] = self.output
        if self.metadata:
            d["metadata"] = self.metadata
        if self.ended_at:
            d["ended_at"] = self.ended_at.isoformat().replace("+00:00", "Z")
        if self.project_id:
            d["project_id"] = self.project_id
        if self.spans:
            d["spans"] = [s.to_dict() for s in self.spans]
        return d
