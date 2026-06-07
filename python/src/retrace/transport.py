from __future__ import annotations

import json
import logging
import queue
import threading
import time
from typing import Any

import requests

from .config import get_config
from .trace import Trace

logger = logging.getLogger("retrace")


class WSTransport:
    """WebSocket transport using websocket-client (sync) for span streaming.

    All network I/O (connect, auth handshake, send) runs on a dedicated background daemon
    thread. The public ``send`` only enqueues onto a bounded queue and never blocks the
    caller — so the first traced event no longer stalls the user's app while the socket
    connects, and a slow/unreachable API can't serialize the caller's threads.
    """

    def __init__(self):
        self._ws = None
        self._lock = threading.RLock()
        self._connected = False
        self._backoff = 1.0
        self._listener_thread = None
        self._closed = False
        # Bounded outbound queue doubles as the offline buffer (cap 1000).
        self._send_queue: "queue.Queue[str]" = queue.Queue(maxsize=1000)
        self._worker_thread = None
        self._worker_lock = threading.Lock()
        # Integrity tracking for the bounded offline buffer (F-DL2 parity with TS).
        self._lossy_traces: set[str] = set()
        self._dropped_open_spans: set[str] = set()
        self._dropped_total = 0
        self._last_drop_warn = 0.0
        # Throttle for the default (no-callback) server-signal warning, keyed per code, so a
        # rate_limited storm can't flood the logs (same lesson as the drop-warn).
        self._last_signal_warn: dict[str, float] = {}

    def _connect(self):
        """Open the socket + auth handshake. Runs ONLY on the worker thread."""
        import websocket

        cfg = get_config()
        url = f"{cfg.ws_url}/ws/v1/stream"
        try:
            self._ws = websocket.create_connection(url, timeout=5)
            # Auth
            self._ws.send(json.dumps({"type": "auth", "api_key": cfg.api_key}))
            resp = json.loads(self._ws.recv())
            if resp.get("type") == "auth_ok":
                self._connected = True
                self._backoff = 1.0
                self._start_listener()
            else:
                self._ws.close()
                self._ws = None
        except Exception as e:
            logger.debug(f"WebSocket connection failed: {e}")
            self._ws = None
            self._connected = False

    def _ensure_worker(self):
        if self._worker_thread and self._worker_thread.is_alive():
            return
        with self._worker_lock:
            if self._worker_thread and self._worker_thread.is_alive():
                return
            self._worker_thread = threading.Thread(target=self._run_worker, daemon=True, name="retrace-ws-sender")
            self._worker_thread.start()

    def _run_worker(self):
        """Drain the send queue, connecting/reconnecting as needed — off the caller thread."""
        pending: str | None = None
        while not self._closed:
            try:
                if pending is None:
                    pending = self._send_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if not self._connected or self._ws is None:
                self._connect()
            if not self._connected or self._ws is None:
                # Couldn't connect — hold `pending` and back off (it stays buffered).
                time.sleep(self._backoff)
                self._backoff = min(self._backoff * 2, 30.0)
                continue
            try:
                with self._lock:
                    self._ws.send(pending)
                pending = None
                self._backoff = 1.0
            except Exception as e:
                logger.debug(f"WebSocket send failed: {e}")
                self._connected = False
                self._ws = None
                # keep `pending`; it will be retried after reconnect

    def _start_listener(self):
        """Start background thread to listen for server-initiated messages (resume, ping)."""
        if self._listener_thread and self._listener_thread.is_alive():
            return

        def _listen():
            import socket as _socket
            while self._connected and not self._closed and self._ws:
                try:
                    self._ws.settimeout(1.0)
                    msg = self._ws.recv()
                except (_socket.timeout, TimeoutError):
                    continue  # idle poll — expected, not an error
                except Exception as e:
                    logger.debug(f"WebSocket recv ended: {e}")
                    break  # connection closed/broken — exit loop, reconnect logic handles it
                # Dispatch is isolated from recv so a single bad frame can't kill the listener,
                # and is NOT silently swallowed (the F-P6 class) — unhandled types throttled-warn.
                try:
                    self._dispatch(json.loads(msg))
                except Exception as e:
                    self._throttled_signal_warn("dispatch", f"[retrace] dropped an unhandled server frame: {e}")

        self._listener_thread = threading.Thread(target=_listen, daemon=True, name="retrace-ws-listener")
        self._listener_thread.start()

    def _dispatch(self, parsed: dict):
        from .errors import classify_server_signal
        mtype = parsed.get("type")
        if mtype == "ping":
            with self._lock:
                if self._ws:
                    self._ws.send(json.dumps({"type": "pong"}))
        elif mtype == "resume":
            from .resume import handle_resume, parse_resume_message
            cmd = parse_resume_message(parsed)
            if cmd:
                handle_resume(cmd)
        elif mtype == "replay":
            from .replay import handle_replay, parse_replay_message
            cmd = parse_replay_message(parsed)
            if cmd:
                handle_replay(cmd)
        elif mtype == "error":
            # F-P6: server `error` frames were previously SWALLOWED. Surface them as a structured
            # signal (credits_exhausted / rate_limited / error) through on_error / throttled-warn.
            self._surface_signal(classify_server_signal("error", parsed.get("error", "")))
        elif mtype == "halt":
            reason = (parsed.get("data") or {}).get("reason", "Guardrail triggered")
            signal = classify_server_signal("halt", reason)
            # halt CHANGES behavior, deliberately: surface the fatal signal, flush what's already
            # recorded, then STOP recording (close). Distinct from credits_exhausted, which leaves
            # recording alive so the user can swap keys / upgrade mid-run.
            self._surface_signal(signal)
            self.close()
        else:
            # DEFAULT: an unknown/unhandled message type must not vanish silently — the durable
            # F-P6 fix (the next new server type surfaces instead of being swallowed).
            self._throttled_signal_warn(f"unknown:{mtype}", f"[retrace] ignoring unknown server message type {mtype!r} (SDK may be outdated)")

    def _surface_signal(self, signal):
        """Hand a structured signal to on_error (WRAPPED — a throwing user callback must never kill
        the listener thread), or throttled-warn by default. Never silent, never an unthrottled storm."""
        cb = get_config().on_error
        if cb is not None:
            try:
                cb(signal)
            except Exception as e:
                self._throttled_signal_warn("on_error:threw", f"[retrace] on_error callback threw (recording continues): {e}")
            return
        suffix = " (recording halted)" if signal.fatal else (" — retryable, back off and retry" if signal.retryable else "")
        self._throttled_signal_warn(signal.code, f"[retrace] server signal {signal.code}{suffix}: {signal.message}")

    def _throttled_signal_warn(self, key: str, line: str):
        now = time.time()
        if now - self._last_signal_warn.get(key, 0.0) > 5.0:
            logger.warning(line)
            self._last_signal_warn[key] = now

    def send(self, event_type: str, data: dict[str, Any]):
        """Non-blocking: enqueue the message for the background worker to deliver."""
        if self._closed:
            return
        # Guard A: unconfigured (no API key) → never buffer, never reach the network. An
        # imported-but-unused SDK leaves zero footprint.
        if not get_config().api_key:
            return
        trace_id = data.get("trace_id") or data.get("id")
        span_id = data.get("id") if event_type.startswith("span") else None
        # Open-span-drop no-op: suppress the orphan close of a span whose open was evicted.
        if event_type == "span_ended" and span_id in self._dropped_open_spans:
            self._dropped_open_spans.discard(span_id)
            return
        # Stamp trace-level lossy on a trace_ended whose trace lost events to a buffer drop, so the
        # server/replay refuses byte-deterministic replay.
        if event_type == "trace_ended" and trace_id in self._lossy_traces:
            data = {**data, "lossy": True}
        msg = json.dumps({"type": event_type, "data": data})
        self._ensure_worker()
        try:
            self._send_queue.put_nowait(msg)
        except queue.Full:
            self._drop_oldest()
            try:
                self._send_queue.put_nowait(msg)
            except queue.Full:
                pass

    def _drop_oldest(self):
        """Evict the oldest queued event: mark its trace lossy, remember a dropped open span so its
        later close is a no-op, and warn (throttled, cumulative — a sustained outage drops
        continuously; per-event logging would be its own perf problem)."""
        try:
            dropped = self._send_queue.get_nowait()
        except queue.Empty:
            return
        try:
            m = json.loads(dropped)
            d = m.get("data", {})
            tid = d.get("trace_id") or d.get("id")
            if tid:
                self._lossy_traces.add(tid)
            if m.get("type") == "span_started" and d.get("id"):
                self._dropped_open_spans.add(d["id"])
        except Exception:
            pass
        self._dropped_total += 1
        now = time.time()
        if now - self._last_drop_warn > 5.0:
            logger.warning(
                "[retrace] send buffer full (cap 1000): %d event(s) dropped so far (oldest-first, "
                "API unreachable); affected traces are marked lossy and excluded from byte-deterministic replay",
                self._dropped_total,
            )
            self._last_drop_warn = now

    def has_pending_data(self) -> bool:
        """True if there is anything worth flushing on exit (Guard B)."""
        return not self._send_queue.empty()

    def is_trace_lossy(self, trace_id: str) -> bool:
        return trace_id in self._lossy_traces

    def _report_dropped(self):
        if self._dropped_total > 0:
            logger.warning(
                "[retrace] shutdown: %d event(s) were dropped this session due to buffer overflow "
                "(API unreachable); affected traces are lossy and excluded from byte-deterministic replay",
                self._dropped_total,
            )

    def reset_for_child(self):
        """After os.fork: a child inherits the parent's buffered events + dead worker/socket refs.
        Clear them so a forked worker (gunicorn pre-fork) never re-emits the parent's buffer."""
        self._send_queue = queue.Queue(maxsize=1000)
        self._ws = None
        self._connected = False
        self._worker_thread = None
        self._listener_thread = None
        self._lossy_traces = set()
        self._dropped_open_spans = set()
        self._dropped_total = 0

    def close(self):
        # Guard B: nothing pending → no worker spin-up, no drain wait, no exit penalty.
        if self._send_queue.empty():
            with self._lock:
                self._closed = True
                if self._ws:
                    try:
                        self._ws.close()
                    except Exception as e:
                        logger.debug(f"WebSocket close error: {e}")
                    self._ws = None
                    self._connected = False
            self._report_dropped()
            return
        # Give the background worker a window to connect (if it hasn't yet) AND flush queued
        # messages before shutdown. We wait regardless of `self._connected`: on a slow/unreachable
        # API the socket may not have connected on the first attempt, and bailing out here would
        # discard every queued span (the HTTP fallback PATCH only carries trace-level fields, not
        # spans). Ensure the worker is running so it actively drains during this window.
        self._ensure_worker()
        deadline = time.time() + 5.0
        while time.time() < deadline and not self._send_queue.empty():
            time.sleep(0.05)
        with self._lock:
            self._closed = True
            if self._ws:
                try:
                    self._ws.close()
                except Exception as e:
                    logger.debug(f"WebSocket close error: {e}")
                self._ws = None
                self._connected = False
        self._report_dropped()


class HTTPTransport:
    """HTTP fallback transport using requests."""

    def __init__(self):
        self._trace_data: dict | None = None
        self._spans: list[dict] = []
        self._lock = threading.RLock()

    def send_trace(self, trace: Trace):

        cfg = get_config()
        url = f"{cfg.base_url}/api/v1/traces"
        headers = {"x-retrace-key": cfg.api_key, "Content-Type": "application/json"}
        try:
            requests.post(url, json=trace.to_dict(), headers=headers, timeout=10)
        except Exception as e:
            logger.debug(f"HTTP send_trace failed: {e}")

    def send(self, event_type: str, data: dict[str, Any]):
        # Guard A: unconfigured (no API key) → don't buffer.
        if not get_config().api_key:
            return
        with self._lock:
            if event_type == "trace_started":
                self._trace_data = dict(data)
            elif event_type in ("span_started", "span_ended"):
                self._spans.append({"_event": event_type, **data})
            elif event_type == "trace_ended":
                if self._trace_data:
                    self._trace_data.update(data)
                self.flush()

    def has_pending_data(self) -> bool:
        return self._trace_data is not None or len(self._spans) > 0

    def flush(self, exit_mode: bool = False):
        with self._lock:
            if not self._trace_data:
                return
            # Merge span_started and span_ended events into complete spans
            merged: dict[str, dict] = {}
            for ev in self._spans:
                event_type = ev.pop("_event", None)
                span_id = ev.get("id", "")
                if event_type == "span_started":
                    merged[span_id] = dict(ev)
                elif event_type == "span_ended" and span_id in merged:
                    merged[span_id].update(ev)
            self._trace_data["spans"] = list(merged.values())

            cfg = get_config()
            url = f"{cfg.base_url}/api/v1/traces"
            headers = {"x-retrace-key": cfg.api_key, "Content-Type": "application/json"}
            # Exit path must not hang the interpreter: a single ~1.5s attempt, no retries/backoff.
            timeout = 1.5 if exit_mode else 10
            attempts = 1 if exit_mode else 3
            for attempt in range(attempts):
                try:
                    resp = requests.post(url, json=self._trace_data, headers=headers, timeout=timeout)
                    if resp.status_code < 300:
                        break  # success
                    if resp.status_code < 500 and resp.status_code != 429:
                        # 4xx (client/payload error) won't succeed on retry — surface it loudly
                        # rather than silently dropping the trace.
                        logger.error(
                            "[retrace] trace upload rejected (HTTP %s): %s",
                            resp.status_code, (resp.text or "")[:300],
                        )
                        break
                    # 5xx / 429 — transient
                    if attempt == attempts - 1:
                        logger.error(
                            "[retrace] trace upload failed after %d attempts (HTTP %s): %s",
                            attempts, resp.status_code, (resp.text or "")[:200],
                        )
                    else:
                        time.sleep(0.5 * (2 ** attempt))
                        continue
                except Exception as e:
                    if attempt == attempts - 1:
                        logger.error("[retrace] trace upload network error after %d attempts: %s", attempts, e)
                    else:
                        time.sleep(0.5 * (2 ** attempt))  # 0.5s, 1s backoff
                        continue
                break
            self._trace_data = None
            self._spans = []

    def close(self):
        self.flush(exit_mode=True)


def create_transport(mode: str = "auto") -> WSTransport | HTTPTransport:
    if mode == "http":
        return HTTPTransport()
    if mode == "ws":
        return WSTransport()
    # Auto: try WS
    try:
        import websocket  # noqa: F401
        return WSTransport()
    except ImportError:
        return HTTPTransport()
