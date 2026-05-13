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

## API Key

A Retrace API key (`rt_live_...`) is required. Get yours free at [retrace.yashbogam.me/settings](https://retrace.yashbogam.me/settings).

## Links

- [Documentation](https://retrace.yashbogam.me/docs)
- [GitHub](https://github.com/yash1511-bogam/retrace)
- [PyPI](https://pypi.org/project/retrace-sdk/)
