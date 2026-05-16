# retrace-sdk

The execution replay engine for AI agents. Record every LLM call, tool invocation, and error your AI agent makes. Replay step-by-step. Fork from any point. Share interactive traces via URL.

## Install

```bash
pip install retrace-sdk
```

Requires Python 3.10+.

## Quick Start

```python
import retrace

retrace.configure(api_key="rt_live_...")  # Get your key at retrace.yashbogam.me/settings

@retrace.record(name="my-agent")
def run_agent(prompt: str):
    response = client.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content

run_agent("What is quantum computing?")
```

## Auto-Instrumentation

Retrace automatically captures LLM calls from all major providers:

```python
# OpenAI — captured automatically
# Anthropic — captured automatically
# Google Gemini — captured automatically
```

No extra setup needed. Install the provider SDK alongside `retrace-sdk` and calls are captured.

## Features

- **Record** — One decorator captures every LLM call, tool call, and error
- **Replay** — Step through executions with play/pause/speed controls
- **Fork** — Branch from any step, modify input, watch a new path diverge
- **Share** — Publish traces as shareable "tapes" with interactive playback
- **Retrace AI** — Built-in evaluations, memory extraction, and semantic search

## Resumable Execution (Cascade Replay)

Mark a function as resumable to enable full cascade replay from the dashboard:

```python
@retrace.record(name="my-agent", resumable=True)
def run_agent(prompt: str):
    plan = call_planner(prompt)
    result = call_executor(plan)
    return summarize(result)
```

When you fork at any span in the dashboard, the SDK re-executes the entire function with modified input — all subsequent LLM calls diverge.

## Error Handling

```python
from retrace import RetraceError, RetraceAuthError, RetraceCreditsExhaustedError, RetraceRateLimitError
```

## Sampling

```python
retrace.configure(api_key="rt_live_...", sample_rate=0.1)  # Record 10% of traces
```

## Changelog

### 0.2.2

- Version sync with TypeScript SDK

### 0.2.1

- **Offline buffer** — stores up to 1000 messages when WebSocket disconnects, flushes on reconnect
- **Dedicated listener thread** — receives server 'resume' commands without needing active sends
- **Cascade replay** — `resumable=True` registers function for SDK-level re-execution
- **Fixed** — duplicate except block in transport, proper close() cleanup

### 0.2.0

- Typed errors (RetraceAuthError, RetraceCreditsExhaustedError, RetraceRateLimitError)
- Trace sampling via `sample_rate` config
- Auto-instrumentation for OpenAI, Anthropic, Gemini
- WebSocket transport with auto-reconnect

## Links

- [Documentation](https://retrace.yashbogam.me/docs)
- [GitHub](https://github.com/yash1511-bogam/retrace)
- [PyPI](https://pypi.org/project/retrace-sdk/)
