"""Tests for the framework adapters (LangChain/LangGraph + CrewAI).

These use a fake recorder so they run without langchain/crewai installed and without a network.
"""
from retrace.adapters.langchain import RetraceCallbackHandler
from retrace.adapters.crewai import retrace_step_callback, retrace_task_callback
from retrace.trace import SpanType


class _FakeSpan:
    def __init__(self, sid):
        self.id = sid


class FakeRecorder:
    def __init__(self):
        self.starts = []  # (name, span_type, input, span_id)
        self.ends = []     # (span_id, output, error)
        self._n = 0

    def start_span(self, name, span_type=SpanType.LLM_CALL, input=None, model=None, parent_id=None):
        self._n += 1
        sid = f"s{self._n}"
        self.starts.append((name, span_type, input, sid))
        return _FakeSpan(sid)

    def end_span(self, span_id, output=None, error=None):
        self.ends.append((span_id, output, error))


def test_langchain_tool_emits_call_and_result():
    rec = FakeRecorder()
    h = RetraceCallbackHandler(recorder=rec)
    h.on_tool_start({"name": "search"}, "query", run_id="r1")
    h.on_tool_end("result-text", run_id="r1")
    types = [s[1] for s in rec.starts]
    assert SpanType.TOOL_CALL in types
    assert SpanType.TOOL_RESULT in types
    # verbatim tool result captured
    assert any(e[1] == "result-text" for e in rec.ends)


def test_langchain_chain_is_reasoning_span():
    rec = FakeRecorder()
    h = RetraceCallbackHandler(recorder=rec)
    h.on_chain_start({"name": "MyChain"}, {"x": 1}, run_id="c1")
    h.on_chain_end({"y": 2}, run_id="c1")
    assert rec.starts[0][1] == SpanType.REASONING
    assert rec.ends[-1][0] == rec.starts[0][3]  # closed the right span


def test_langchain_retriever_records_documents():
    rec = FakeRecorder()
    h = RetraceCallbackHandler(recorder=rec)

    class _Doc:
        def __init__(self, c):
            self.page_content = c

    h.on_retriever_start({}, "what is x", run_id="rt1")
    h.on_retriever_end([_Doc("a"), _Doc("b")], run_id="rt1")
    assert rec.starts[0][1] == SpanType.ACTION
    out = rec.ends[-1][1]
    assert '"count": 2' in out or "'count': 2" in str(out)


def test_crewai_step_tool_emits_call_and_result():
    rec = FakeRecorder()

    class Step:
        tool = "calc"
        tool_input = {"a": 1}
        result = "42"

    retrace_step_callback(Step(), recorder=rec)
    types = [s[1] for s in rec.starts]
    assert SpanType.TOOL_CALL in types and SpanType.TOOL_RESULT in types


def test_crewai_step_reasoning():
    rec = FakeRecorder()

    class Step:
        log = "thinking..."

    retrace_step_callback(Step(), recorder=rec)
    assert rec.starts[0][1] == SpanType.REASONING


def test_crewai_task_callback_is_action():
    rec = FakeRecorder()

    class Task:
        raw = "final answer"
        name = "research"

    retrace_task_callback(Task(), recorder=rec)
    assert rec.starts[0][1] == SpanType.ACTION
    assert rec.ends[-1][1] == "final answer"
