# Retrace SDK

Official Python & TypeScript SDKs for [Retrace](https://retrace.yashbogam.me) — the execution replay engine for AI agents.

Record every LLM call, tool invocation, and error your AI agent makes. Replay step-by-step. Fork from any point. Share as a URL.

## Python

```bash
pip install retrace-sdk
```

```python
import retrace

retrace.configure(api_key="rt_live_...")

@retrace.record(name="my-agent")
def run_agent(prompt: str):
    response = client.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "user", "content": prompt}]
    )
    return response.choices[0].message.content
```

## TypeScript

```bash
npm install retrace-sdk
```

```typescript
import { configure, trace } from "retrace-sdk";

configure({ apiKey: "rt_live_..." });

const runAgent = trace(async (prompt: string) => {
  const response = await openai.chat.completions.create({
    model: "gpt-5.5",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content;
}, { name: "my-agent" });
```

## Documentation

Full docs at [retrace.yashbogam.me/docs](https://retrace.yashbogam.me/docs)

## License

MIT
