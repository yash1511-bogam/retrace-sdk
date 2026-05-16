# retrace-sdk

The execution replay engine for AI agents. Record, replay, fork & share AI agent executions — TypeScript SDK.

## Installation

```bash
npm install retrace-sdk
```

Requires Node.js 20+. ESM-only package.

## Quick Start

```typescript
import { configure, trace } from "retrace-sdk";

configure({ apiKey: "rt_live_..." }); // Get your key at retrace.yashbogam.me/settings

const myAgent = trace(async (prompt: string) => {
  const response = await openai.chat.completions.create({
    model: "gpt-5.5",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content;
}, { name: "my-agent" });

await myAgent("What is quantum computing?");
```

## Auto-Instrumentation

LLM calls from all major providers are captured automatically:

- **OpenAI** — `openai.chat.completions.create()` captured
- **Anthropic** — `anthropic.messages.create()` captured
- **Google Gemini** — `ai.models.generateContent()` captured

No extra setup needed. Install the provider SDK alongside `retrace-sdk`.

## Configuration

```typescript
import { configure } from "retrace-sdk";

configure({
  apiKey: "rt_live_...",           // or RETRACE_API_KEY env var
  baseUrl: "https://api-retrace.yashbogam.me",
  projectId: "...",                 // or RETRACE_PROJECT_ID env var
});
```

Set `RETRACE_ENABLED=false` to disable recording without changing code.

## Manual Span Creation

```typescript
import { record, SpanType } from "retrace-sdk";

const recorder = record({ name: "custom-agent" });
recorder.start();

const span = recorder.startSpan("web-search", SpanType.TOOL_CALL, { query: "latest news" });
// ... do work ...
recorder.endSpan(span, { results: ["..."] });

recorder.end("Done");
```

## Resumable Execution (Cascade Replay)

Mark a function as resumable to enable full cascade replay from the dashboard:

```typescript
import { configure, trace } from "retrace-sdk";

configure({ apiKey: "rt_live_..." });

const myAgent = trace(async (prompt: string) => {
  const plan = await planner(prompt);
  const result = await executor(plan);
  return summarize(result);
}, { name: "my-agent", resumable: true });
```

When you fork at any span in the dashboard, the SDK re-executes the entire function with modified input — not just one LLM call.

## Error Handling

```typescript
import { RetraceError, RetraceAuthError, RetraceCreditsExhaustedError, RetraceRateLimitError } from "retrace-sdk";
```

Typed errors for auth failures, credit exhaustion, and rate limiting.

## Sampling

```typescript
configure({ apiKey: "rt_live_...", sampleRate: 0.1 }); // Record 10% of traces
```

## Changelog

### 0.2.2

- **Fixed** — OpenAI interceptor no longer creates dummy client instance to find prototype

### 0.2.1

- **Offline buffer** — stores up to 1000 messages when WebSocket disconnects, flushes on reconnect
- **HTTP retry** — 3 attempts with exponential backoff on fallback transport
- **Cascade replay** — `resumable: true` option registers function for SDK-level re-execution
- **Resume listener** — handles server 'resume' commands for fork replay

### 0.2.0

- Typed errors (RetraceAuthError, RetraceCreditsExhaustedError, RetraceRateLimitError)
- Trace sampling via `sampleRate` config
- Auto-instrumentation for OpenAI, Anthropic, Gemini
- WebSocket + HTTP fallback transport

## Links

- [Documentation](https://retrace.yashbogam.me/docs)
- [GitHub](https://github.com/yash1511-bogam/retrace)
- [npm](https://www.npmjs.com/package/retrace-sdk)
