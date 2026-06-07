import WebSocket from "ws";
import { getConfig } from "./config.js";
import { classifyServerSignal, type RetraceServerSignal } from "./errors.js";

export interface Transport {
  send(eventType: string, data: Record<string, unknown>): void;
  close(): void;
  /** Drain in-flight data to the network (awaited on graceful shutdown). */
  flush(): Promise<void>;
  /** Exit/signal path: drain via the most reliable channel for teardown (HTTP one-shot for
   *  buffered events), bounded by budgetMs. Falls back to flush() when not implemented. */
  flushOnExit?(budgetMs?: number): Promise<void>;
  /** True if there is anything worth flushing (buffered events or an unsent in-flight payload).
   *  Lets the exit path no-op — no fetch, no delay — for a zero-event run. */
  hasPendingData?(): boolean;
  /** Server-signal channel: a STRUCTURED signal (code/retryable/fatal), not a raw string — branch
   *  on `signal.code`, never string-match `signal.message`. */
  onError?: (signal: RetraceServerSignal) => void;
}

interface QueuedEvent {
  eventType: string;
  data: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

export class WSTransport implements Transport {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private backoff = 1000;
  private queue: QueuedEvent[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // F-DL2: integrity tracking for the bounded offline buffer.
  private lossyTraces = new Set<string>();        // traces that lost ≥1 event to a buffer drop
  private droppedOpenSpanIds = new Set<string>(); // open spans dropped → their later close is a no-op
  private droppedTotal = 0;
  private lastDropWarnMs = 0;
  // Throttle for the default (no-callback) server-signal warning, keyed per code, so a
  // rate_limited storm can't spew thousands of lines (same lesson as the drop-warn).
  private lastSignalWarnMs = new Map<string, number>();
  onError?: (signal: RetraceServerSignal) => void;

  get isConnected() { return this.connected; }

  /** Whether a trace lost events to a buffer drop (so the API/replay can refuse byte-replay). */
  isTraceLossy(traceId: string) { return this.lossyTraces.has(traceId); }

  connect() {
    if (this.closed) return;
    const cfg = getConfig();
    const url = `${cfg.wsUrl}/ws/v1/stream`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      // Unref the underlying socket so a short-lived script (the common SDK usage) can exit
      // once its work is done instead of hanging on an open WebSocket. Graceful shutdown
      // still drains via flush()/beforeExit.
      (this.ws as unknown as { _socket?: { unref?: () => void } })?._socket?.unref?.();
      this.ws!.send(JSON.stringify({ type: "auth", api_key: cfg.apiKey }));
    });

    this.ws.on("message", (raw) => {
     try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        this.connected = true;
        this.backoff = 1000;
        this.flushQueue();
      } else if (msg.type === "ping") {
        this.ws?.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "error") {
        this.surfaceSignal(classifyServerSignal("error", msg.error as string));
      } else if (msg.type === "resume") {
        import("./resume.js").then(({ parseResumeMessage, handleResume }) => {
          const cmd = parseResumeMessage(msg);
          if (cmd) handleResume(cmd);
        });
      } else if (msg.type === "replay") {
        import("./replay.js").then(({ parseReplayMessage, handleReplay }) => {
          const cmd = parseReplayMessage(msg);
          if (cmd) handleReplay(cmd);
        });
      } else if (msg.type === "halt") {
        const reason = (msg.data as { reason?: string })?.reason || "Guardrail triggered";
        const signal = classifyServerSignal("halt", reason);
        // halt CHANGES behavior, deliberately: flush what's already recorded, then STOP recording
        // (close the transport). This is a hard server directive, distinct from credits_exhausted
        // (which leaves recording alive so the user can swap keys / upgrade mid-run). Surfaced as a
        // fatal signal — never a silent dark-out.
        this.surfaceSignal(signal);
        void this.flush().finally(() => this.close());
      } else {
        // DEFAULT: an unhandled/unknown server message type must not be silently swallowed (the
        // F-P6 class). Throttled-warn so a future message type surfaces instead of vanishing.
        this.warnUnknownType(msg.type);
      }
     } catch (e) {
       // A malformed/unparseable frame must not take down the listener.
       this.throttledSignalWarn("parse", `[retrace] dropped an unparseable server frame: ${(e as Error)?.message ?? e}`);
     }
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.ws = null;
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.reconnect(), this.backoff * (0.5 + Math.random() * 0.5));
        // Don't let the reconnect timer keep the event loop (and the process) alive.
        (this.reconnectTimer as unknown as { unref?: () => void })?.unref?.();
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
      this.transmit(this.queue.shift()!);
    }
  }

  /** Serialize + send a single event, stamping trace-level `lossy` on a trace_ended whose trace
   *  lost events to a buffer drop (so the server/replay can refuse byte-deterministic replay). */
  private transmit(item: QueuedEvent) {
    if (item.eventType === "trace_ended" && item.traceId && this.lossyTraces.has(item.traceId)) {
      item.data.lossy = true;
    }
    this.ws?.send(JSON.stringify({ type: item.eventType, data: item.data }));
  }

  /** Enqueue with a bounded (1000) buffer. On overflow drop the OLDEST event, mark its trace lossy,
   *  and if it was an open span (span_started) remember its id so the later close is a no-op. */
  private enqueue(item: QueuedEvent) {
    if (this.queue.length >= 1000) {
      const dropped = this.queue.shift();
      if (dropped) {
        if (dropped.traceId) this.lossyTraces.add(dropped.traceId);
        if (dropped.eventType === "span_started" && dropped.spanId) this.droppedOpenSpanIds.add(dropped.spanId);
        this.recordDrop();
      }
    }
    this.queue.push(item);
  }

  /** Throttled drop warning — at most once per ~5s burst, reporting the CUMULATIVE count (a
   *  single-tick burst that exits before the next window would otherwise under-report). A final
   *  summary is emitted on close(). */
  private recordDrop() {
    this.droppedTotal++;
    const now = Date.now();
    if (now - this.lastDropWarnMs > 5000) {
      console.warn(`[retrace] send buffer full (cap 1000): ${this.droppedTotal} event(s) dropped so far (oldest-first, API unreachable); affected traces are marked lossy and excluded from byte-deterministic replay`);
      this.lastDropWarnMs = now;
    }
  }

  /** Surface a structured server signal. If the user registered onError, invoke it WRAPPED — a
   *  throwing user callback must never kill the listener / WS loop (classic footgun). With no
   *  callback, fall back to a throttled console warning (per code) — never silent, never an
   *  unthrottled storm. */
  private surfaceSignal(signal: RetraceServerSignal) {
    if (this.onError) {
      try {
        this.onError(signal);
      } catch (e) {
        this.throttledSignalWarn(`onError:threw`, `[retrace] onError callback threw (recording continues): ${(e as Error)?.message ?? e}`);
      }
      return;
    }
    this.throttledSignalWarn(
      signal.code,
      `[retrace] server signal ${signal.code}${signal.fatal ? " (recording halted)" : ""}: ${signal.message}` +
        (signal.retryable ? " — retryable, back off and retry" : ""),
    );
  }

  private warnUnknownType(type: unknown) {
    this.throttledSignalWarn(`unknown:${String(type)}`, `[retrace] ignoring unknown server message type "${String(type)}" (SDK may be outdated)`);
  }

  /** At most one warn per ~5s per key, so a storm (rate_limited, unknown frames) can't flood. */
  private throttledSignalWarn(key: string, line: string) {
    const now = Date.now();
    const last = this.lastSignalWarnMs.get(key) ?? 0;
    if (now - last > 5000) {
      console.warn(line);
      this.lastSignalWarnMs.set(key, now);
    }
  }

  /** Whether there is anything worth flushing on exit. */
  hasPendingData(): boolean {
    return this.queue.length > 0 || (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount > 0);
  }

  send(eventType: string, data: Record<string, unknown>) {
    // Unconfigured (no API key): never buffer and never reach the network. An imported-but-unused
    // SDK leaves zero footprint — no queued events, nothing for the exit path to send.
    if (!getConfig().apiKey) return;
    const traceId = (data.trace_id ?? data.id) as string | undefined;
    const spanId = eventType.startsWith("span") ? (data.id as string | undefined) : undefined;
    // Open-span-drop no-op: if this span's open was evicted, suppress its orphan close.
    if (eventType === "span_ended" && spanId && this.droppedOpenSpanIds.has(spanId)) {
      this.droppedOpenSpanIds.delete(spanId);
      return;
    }
    const item: QueuedEvent = { eventType, data, traceId, spanId };
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.transmit(item);
    } else {
      this.enqueue(item);
      if (!this.ws && !this.closed) this.connect();
    }
  }

  close() {
    this.closed = true;
    if (this.droppedTotal > 0) {
      console.warn(`[retrace] shutdown: ${this.droppedTotal} event(s) were dropped this session due to buffer overflow (API unreachable); affected traces are lossy and excluded from byte-deterministic replay`);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /** Wait for the socket's send buffer to drain so the final trace_ended actually leaves
   *  the process before exit. Best-effort with a hard timeout. */
  async flush(): Promise<void> {
    const start = Date.now();
    while (this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Exit path: drain a live socket if connected, then HTTP one-shot anything still buffered.
   *  A WS handshake can't reliably complete during teardown, so buffered events (the common
   *  short-lived-script case where WS never connected) go out over HTTP keepalive instead. */
  async flushOnExit(budgetMs = 1500): Promise<void> {
    const deadline = Date.now() + budgetMs;
    if (this.connected) await this.flush();
    if (this.queue.length) await this.flushViaHttp(Math.max(250, deadline - Date.now()));
  }

  /** POST whatever is still buffered over a bounded HTTP keepalive request, grouped by trace.
   *  Incomplete traces (no terminal trace_ended buffered) and already-lossy traces are stamped
   *  lossy:true so the server/replay refuses byte-deterministic replay. */
  private async flushViaHttp(budgetMs: number): Promise<void> {
    if (!this.queue.length) return;
    const cfg = getConfig();
    const deadline = Date.now() + budgetMs;
    const byTrace = new Map<string, { trace?: Record<string, unknown>; ended: boolean; spans: Map<string, Record<string, unknown>> }>();
    for (const item of this.queue.splice(0)) {
      const tid = item.traceId ?? "_";
      let g = byTrace.get(tid);
      if (!g) { g = { ended: false, spans: new Map() }; byTrace.set(tid, g); }
      if (item.eventType === "trace_started") g.trace = { ...(g.trace ?? {}), ...item.data };
      else if (item.eventType === "trace_ended") { g.trace = { ...(g.trace ?? {}), ...item.data }; g.ended = true; }
      else if (item.eventType === "span_started" && item.spanId) g.spans.set(item.spanId, { ...item.data });
      else if (item.eventType === "span_ended" && item.spanId && g.spans.has(item.spanId)) Object.assign(g.spans.get(item.spanId)!, item.data);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budgetMs);
    try {
      for (const [tid, g] of byTrace) {
        if (!g.trace || Date.now() >= deadline) break;
        const lossy = this.lossyTraces.has(tid) || !g.ended;
        const body = JSON.stringify({ ...g.trace, ...(lossy ? { lossy: true } : {}), spans: [...g.spans.values()] });
        try {
          await fetch(`${cfg.baseUrl}/api/v1/traces`, {
            method: "POST",
            headers: { "x-retrace-key": cfg.apiKey, "Content-Type": "application/json" },
            body,
            keepalive: true,
            signal: ctrl.signal,
          });
        } catch { /* best-effort death-flush — process is exiting */ }
      }
    } finally {
      clearTimeout(timer);
    }
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
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.traceData) return;
    const cfg = getConfig();
    const url = `${cfg.baseUrl}/api/v1/traces`;
    const body = { ...this.traceData, spans: this.buildSpans() };
    const payload = JSON.stringify(body);
    // Clear first so a concurrent flush (e.g. trace_ended then shutdown drain) can't double-send.
    this.traceData = null;
    this.spans = [];
    // Retry up to 3 times with exponential backoff; awaited so shutdown can drain it.
    for (let n = 1; n <= 3; n++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "x-retrace-key": cfg.apiKey, "Content-Type": "application/json" },
          body: payload,
        });
        if (res.ok) return;
        const txt = await res.text().catch(() => "");
        // 4xx (except 429) is a client/payload error that won't succeed on retry — surface
        // it loudly and stop, rather than silently dropping the trace.
        if (res.status < 500 && res.status !== 429) {
          console.error(`[retrace] trace upload rejected (HTTP ${res.status}): ${txt.slice(0, 300)}`);
          return;
        }
        // 5xx / 429 — transient; retry.
        if (n === 3) console.error(`[retrace] trace upload failed after ${n} attempts (HTTP ${res.status}): ${txt.slice(0, 200)}`);
      } catch (err) {
        if (n === 3) console.error(`[retrace] trace upload network error after ${n} attempts: ${(err as Error)?.message ?? err}`);
      }
      if (n < 3) await new Promise((r) => setTimeout(r, 1000 * n));
    }
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
    void this.flush();
  }

  /** HTTP is already the one-shot channel — just drain. */
  async flushOnExit(): Promise<void> {
    await this.flush();
  }

  hasPendingData(): boolean {
    return this.traceData !== null || this.spans.length > 0;
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

  const autoTransport: Transport = {
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
    async flush() {
      if (!decided) {
        // Never connected over WS — force the HTTP fallback and drain the buffer so the
        // final trace isn't lost on shutdown.
        decided = true;
        useWs = false;
        clearTimeout(fallbackTimer);
        ws.close();
        for (const item of buffer.splice(0)) http.send(item.eventType, item.data);
        await http.flush();
      } else if (useWs) {
        await ws.flush();
      } else {
        await http.flush();
      }
    },
    async flushOnExit(budgetMs?: number) {
      if (!decided) {
        // Never connected over WS — force HTTP fallback and one-shot the buffer.
        decided = true;
        useWs = false;
        clearTimeout(fallbackTimer);
        ws.close();
        for (const item of buffer.splice(0)) http.send(item.eventType, item.data);
        await http.flushOnExit();
      } else if (useWs) {
        await ws.flushOnExit(budgetMs);
      } else {
        await http.flushOnExit();
      }
    },
    hasPendingData() {
      if (!decided) return buffer.length > 0;
      return useWs ? ws.hasPendingData() : http.hasPendingData();
    },
  };
  // Forward the user's onError to the inner WS transport so ITS surfaceSignal owns the policy
  // (callback-safety + throttled default-warn). Critically, when no user callback is set we leave
  // ws.onError undefined so the inner transport takes its DEFAULT-warn path — a forwarder that is
  // always-truthy would mask the default and re-create a silent dark-out.
  let _userOnError: ((signal: RetraceServerSignal) => void) | undefined;
  Object.defineProperty(autoTransport, "onError", {
    get() { return _userOnError; },
    set(v: ((signal: RetraceServerSignal) => void) | undefined) { _userOnError = v; ws.onError = v; },
    configurable: true,
  });
  return autoTransport;
}

export type ExitReason = "graceful" | "signal" | "uncaught";
const preExitHooks: Array<(reason: ExitReason) => void> = [];

/**
 * Register a synchronous hook run on the exit/signal path BEFORE the transport drains — e.g. the
 * ambient trace finishing itself (emitting trace_ended) so it's in the buffer for the drain.
 */
export function onProcessExit(fn: (reason: ExitReason) => void): void {
  preExitHooks.push(fn);
}

/**
 * Wire process-exit flushing for a shared transport. Node's exit hooks are weaker than Python's
 * atexit, so we cover three paths with different ownership semantics:
 *  - beforeExit: graceful (loop emptied naturally). Drain; do not exit (Node exits after).
 *  - SIGTERM/SIGINT, and WE are the sole listener: adding a listener suppresses Node's default
 *    terminate, so we now OWN the exit — flush THEN process.exit(), or the process hangs forever.
 *  - SIGTERM/SIGINT, but the USER already has handlers: best-effort flush only; their handler owns
 *    exit. We do not exit, and cannot guarantee our async flush completes (a synchronous
 *    process.exit() in their handler will cut it off).
 *
 * Irreducible residual (both SDKs): process.exit() mid-flush, os._exit(), and SIGKILL bypass these
 * hooks entirely and lose still-buffered events; a framework-owned SIGTERM (we stay a guest) drains
 * only what that framework's shutdown allows. Both SDKs DO flush on a sole-owner SIGTERM (TS via the
 * listenerCount gate here; Python via a SIG_DFL/main-thread gate) — that parity is real.
 */
export function registerProcessExitFlush(transport: Transport, budgetMs = 1500): void {
  const drain = async (reason: ExitReason) => {
    for (const h of preExitHooks) { try { h(reason); } catch { /* hook best-effort */ } }
    // No-op when there's nothing to send (zero-event run): no fetch, no delay. Open-span
    // finalization in the hooks above runs first, so a stream that opened but never closed still
    // produces events to flush; a truly empty run leaves zero footprint.
    if (transport.hasPendingData && !transport.hasPendingData()) return;
    if (transport.flushOnExit) await transport.flushOnExit(budgetMs);
    else await transport.flush();
  };

  let draining = false;
  process.on("beforeExit", () => {
    if (draining) return;
    draining = true;
    void drain("graceful").finally(() => { draining = false; });
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const userOwnsExit = process.listenerCount(sig) > 0; // captured BEFORE we register ours
    process.on(sig, () => {
      drain("signal").finally(() => {
        // Sole listener: we suppressed the default terminate, so we must exit or the process hangs.
        // User has their own handler: they own exit — never call it for them.
        if (!userOwnsExit) process.exit(sig === "SIGINT" ? 130 : 143);
      });
    });
  }
}
