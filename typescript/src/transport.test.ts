import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure } from "./config.js";

// Mock WebSocket to never connect (simulates unreachable WS endpoint)
const mockWsInstances: Array<Record<string, unknown>> = [];
vi.mock("ws", () => {
  const MockWebSocket = function (this: Record<string, unknown>) {
    this.readyState = 0;
    this._listeners = {} as Record<string, Array<() => void>>;
    this.on = (event: string, cb: () => void) => { ((this._listeners as Record<string, Array<() => void>>)[event] ??= []).push(cb); return this; };
    this.send = vi.fn();
    this.close = vi.fn(() => {
      this.readyState = 3;
      for (const cb of ((this._listeners as Record<string, Array<() => void>>)["close"] ?? [])) cb();
    });
    mockWsInstances.push(this);
  } as unknown as { new(): Record<string, unknown>; OPEN: number };
  MockWebSocket.OPEN = 1;
  return { default: MockWebSocket };
});

beforeEach(() => {
  configure({ apiKey: "rt_live_test", baseUrl: "http://localhost:3001", enabled: true });
  mockWsInstances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Auto transport fallback on early close()", () => {
  it("flushes to HTTP when close() is called before WS connects", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { createTransport } = await import("./transport.js");
    const transport = createTransport("auto");

    // Send trace events immediately (before WS could connect)
    transport.send("trace_started", { id: "t1", name: "fast-trace", status: "running", started_at: "2026-01-01T00:00:00Z", total_tokens: 0, total_cost: 0, total_duration_ms: 0 });
    transport.send("span_started", { id: "s1", trace_id: "t1", span_type: "llm_call", name: "call", started_at: "2026-01-01T00:00:00Z" });
    transport.send("span_ended", { id: "s1", ended_at: "2026-01-01T00:00:01Z", output: "response" });
    transport.send("trace_ended", { id: "t1", ended_at: "2026-01-01T00:00:01Z", status: "completed" });

    // Close immediately — WS has NOT connected yet
    transport.close();

    // Should have fallen back to HTTP and flushed
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3001/api/v1/traces");
    const body = JSON.parse(opts.body);
    expect(body.id).toBe("t1");
    expect(body.name).toBe("fast-trace");
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].output).toBe("response");
  });

  it("does NOT reconnect after intentional close()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { WSTransport } = await import("./transport.js");
    const ws = new WSTransport();
    ws.connect();

    // Should have created a WS instance
    expect(mockWsInstances.length).toBeGreaterThan(0);
    const instanceCount = mockWsInstances.length;

    // Close intentionally
    ws.close();

    // Trigger the "close" event that was registered — already fired by our mock's close()
    // Wait a tick for any setTimeout reconnect to fire
    await new Promise(r => setTimeout(r, 1100));

    // Should NOT have created new WS instances (no reconnect)
    expect(mockWsInstances.length).toBe(instanceCount);
  });
});
