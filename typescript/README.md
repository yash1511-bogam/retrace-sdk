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

## API Key

A Retrace API key (`rt_live_...`) is required. Get yours free at [retrace.yashbogam.me/settings](https://retrace.yashbogam.me/settings).

## Links

- [Documentation](https://retrace.yashbogam.me/docs)
- [GitHub](https://github.com/yash1511-bogam/retrace)
- [npm](https://www.npmjs.com/package/retrace-sdk)
