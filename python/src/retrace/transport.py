from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

import requests

logger = logging.getLogger("retrace")

from .config import get_config
from .trace import Trace


class WSTransport:
    """WebSocket transport using websocket-client (sync) for span streaming."""

    def __init__(self):
        self._ws = None
        self._lock = threading.RLock()
        self._connected = False
        self._backoff = 1.0
        self._listener_thread = None
        self._closed = False
        self._offline_buffer: list[str] = []

    def connect(self):
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

    def _start_listener(self):
        """Start background thread to listen for server-initiated messages (resume, ping)."""
        if self._listener_thread and self._listener_thread.is_alive():
            return

        def _listen():
            while self._connected and not self._closed and self._ws:
                try:
                    self._ws.settimeout(1.0)
                    msg = self._ws.recv()
                    parsed = json.loads(msg)
                    if parsed.get("type") == "ping":
                        with self._lock:
                            if self._ws:
                                self._ws.send(json.dumps({"type": "pong"}))
                    elif parsed.get("type") == "resume":
                        from .resume import parse_resume_message, handle_resume
                        cmd = parse_resume_message(parsed)
                        if cmd:
                            handle_resume(cmd)
                except Exception:
                    pass  # timeout or connection closed

        self._listener_thread = threading.Thread(target=_listen, daemon=True, name="retrace-ws-listener")
        self._listener_thread.start()

    def _ensure_connected(self):
        if not self._connected or self._ws is None:
            self.connect()

    def send(self, event_type: str, data: dict[str, Any]):
        msg = json.dumps({"type": event_type, "data": data})
        with self._lock:
            self._ensure_connected()
            if not self._ws:
                # Offline buffer — store up to 1000 messages
                if len(self._offline_buffer) < 1000:
                    self._offline_buffer.append(msg)
                return
            try:
                # Flush offline buffer first
                while self._offline_buffer:
                    self._ws.send(self._offline_buffer.pop(0))
                self._ws.send(msg)
                self._backoff = 1.0
            except Exception as e:
                logger.debug(f"WebSocket send failed: {e}")
                self._connected = False
                self._ws = None
                if len(self._offline_buffer) < 1000:
                    self._offline_buffer.append(msg)

    def close(self):
        with self._lock:
            self._closed = True
            if self._ws:
                try:
                    self._ws.close()
                except Exception as e:
                    logger.debug(f"WebSocket close error: {e}")
                self._ws = None
                self._connected = False


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
        with self._lock:
            if event_type == "trace_started":
                self._trace_data = dict(data)
            elif event_type in ("span_started", "span_ended"):
                self._spans.append({"_event": event_type, **data})
            elif event_type == "trace_ended":
                if self._trace_data:
                    self._trace_data.update(data)
                self.flush()

    def flush(self):
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
            try:
                requests.post(url, json=self._trace_data, headers=headers, timeout=10)
            except Exception as e:
                logger.debug(f"HTTP flush failed: {e}")
            self._trace_data = None
            self._spans = []

    def close(self):
        self.flush()


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
