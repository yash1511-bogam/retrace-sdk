import WebSocket from "ws";
import { getConfig } from "./config.js";

export interface Transport {
  send(eventType: string, data: Record<string, unknown>): void;
  close(): void;
}

export class WSTransport implements Transport {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private backoff = 1000;
  private queue: string[] = [];
  onError?: (type: string, message: string) => void;

  get isConnected() { return this.connected; }

  connect() {
    if (this.closed) return;
    const cfg = getConfig();
    const url = `${cfg.wsUrl}/ws/v1/stream`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.ws!.send(JSON.stringify({ type: "auth", api_key: cfg.apiKey }));
    });

    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        this.connected = true;
        this.backoff = 1000;
        this.flushQueue();
      } else if (msg.type === "ping") {
        this.ws?.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "error") {
        const err = msg.error as string;
        if (err?.includes("limit reached")) this.onError?.("credits_exhausted", err);
        else if (err?.includes("Rate limit")) this.onError?.("rate_limited", err);
        else this.onError?.("error", err);
      } else if (msg.type === "resume") {
        import("./resume.js").then(({ parseResumeMessage, handleResume }) => {
          const cmd = parseResumeMessage(msg);
          if (cmd) handleResume(cmd);
        });
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.ws = null;
      if (!this.closed) {
        setTimeout(() => this.reconnect(), this.backoff * (0.5 + Math.random() * 0.5));
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    });

    this.ws.on("error", () => {
      this.ws?.close();
    });
  }

  private reconnect() {
    if (!this.closed && !this.connected && !this.ws) this.connect();
  }

  private flushQueue() {
    while (this.queue.length && this.connected) {
      this.ws?.send(this.queue.shift()!);
    }
  }

  send(eventType: string, data: Record<string, unknown>) {
    const msg = JSON.stringify({ type: eventType, data });
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      // Cap offline buffer at 1000 messages to prevent memory leak
      if (this.queue.length < 1000) this.queue.push(msg);
      if (!this.ws && !this.closed) this.connect();
    }
  }

  close() {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

export class HTTPTransport implements Transport {
  private traceData: Record<string, unknown> | null = null;
  private spans: Record<string, unknown>[] = [];

  send(eventType: string, data: Record<string, unknown>) {
    if (eventType === "trace_started") {
      this.traceData = data;
    } else if (eventType === "span_started" || eventType === "span_ended") {
      this.spans.push({ ...data, _event: eventType });
    } else if (eventType === "trace_ended") {
      if (this.traceData) Object.assign(this.traceData, data);
      this.flush();
    }
  }

  flush() {
    if (!this.traceData) return;
    const cfg = getConfig();
    const url = `${cfg.baseUrl}/api/v1/traces`;
    const body = { ...this.traceData, spans: this.buildSpans() };
    const payload = JSON.stringify(body);
    // Retry up to 3 times with exponential backoff
    const attempt = (n: number, delay: number) => {
      fetch(url, {
        method: "POST",
        headers: { "x-retrace-key": cfg.apiKey, "Content-Type": "application/json" },
        body: payload,
      }).catch(() => { if (n < 3) setTimeout(() => attempt(n + 1, delay * 2), delay); });
    };
    attempt(1, 1000);
    this.traceData = null;
    this.spans = [];
  }

  private buildSpans(): Record<string, unknown>[] {
    const merged = new Map<string, Record<string, unknown>>();
    for (const ev of this.spans) {
      const { _event, ...rest } = ev;
      const id = rest.id as string;
      if (_event === "span_started") {
        merged.set(id, rest);
      } else if (_event === "span_ended" && merged.has(id)) {
        Object.assign(merged.get(id)!, rest);
      }
    }
    return [...merged.values()];
  }

  close() {
    this.flush();
  }
}

export function createTransport(mode: "ws" | "http" | "auto" = "auto"): Transport {
  if (mode === "http") return new HTTPTransport();
  if (mode === "ws") return new WSTransport();

  // Auto: start with WS, fall back to HTTP if connection fails within timeout
  const ws = new WSTransport();
  const http = new HTTPTransport();
  let useWs = true;
  let decided = false;
  const buffer: Array<{ eventType: string; data: Record<string, unknown> }> = [];

  const fallbackTimer = setTimeout(() => {
    if (!decided && !ws.isConnected) {
      decided = true;
      useWs = false;
      ws.close();
      for (const item of buffer.splice(0)) http.send(item.eventType, item.data);
    }
  }, 5000);

  ws.connect();

  const originalSend = ws.send.bind(ws);
  const checkConnected = () => {
    if (!decided && ws.isConnected) {
      decided = true;
      clearTimeout(fallbackTimer);
      for (const item of buffer.splice(0)) originalSend(item.eventType, item.data);
    }
  };

  return {
    send(eventType: string, data: Record<string, unknown>) {
      checkConnected();
      if (decided) {
        if (useWs) originalSend(eventType, data);
        else http.send(eventType, data);
      } else {
        buffer.push({ eventType, data });
      }
    },
    close() {
      clearTimeout(fallbackTimer);
      if (!decided) {
        // WS not yet connected — force HTTP fallback to avoid data loss
        decided = true;
        useWs = false;
        ws.close();
        for (const item of buffer.splice(0)) http.send(item.eventType, item.data);
        http.close();
      } else if (useWs) {
        ws.close();
      } else {
        http.close();
      }
    },
  };
}
