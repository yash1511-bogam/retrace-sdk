import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger("retrace")


@dataclass
class RetraceConfig:
    api_key: str = ""
    base_url: str = ""
    project_id: str | None = None
    ws_url: str = ""
    flush_interval: float = 2.0
    enabled: bool = True
    sample_rate: float = 1.0

    def __post_init__(self):
        if not self.api_key:
            self.api_key = os.environ.get("RETRACE_API_KEY", "")
        if not self.base_url:
            self.base_url = os.environ.get("RETRACE_BASE_URL", "http://localhost:3001")
        if not self.project_id:
            self.project_id = os.environ.get("RETRACE_PROJECT_ID") or None
        if not self.ws_url:
            self.ws_url = self.base_url.replace("https://", "wss://").replace("http://", "ws://")
        enabled_env = os.environ.get("RETRACE_ENABLED", "true").lower()
        if enabled_env in ("false", "0", "no"):
            self.enabled = False
        sample_env = os.environ.get("RETRACE_SAMPLE_RATE")
        if sample_env:
            self.sample_rate = float(sample_env)


_config: RetraceConfig | None = None


def get_config() -> RetraceConfig:
    global _config
    if _config is None:
        _config = RetraceConfig()
    return _config


def configure(**kwargs) -> RetraceConfig:
    global _config
    if _config is None:
        _config = RetraceConfig(**kwargs)
    else:
        for k, v in kwargs.items():
            setattr(_config, k, v)
        if "base_url" in kwargs and "ws_url" not in kwargs:
            _config.ws_url = _config.base_url.replace("https://", "wss://").replace("http://", "ws://")
    if _config.api_key and not _config.api_key.startswith("rt_live_"):
        raise ValueError("Invalid Retrace API key. Keys must start with 'rt_live_'. Get yours at https://retrace.yashbogam.me/settings")
    return _config


def require_api_key() -> str:
    """Ensure a valid API key is configured. Raises if not."""
    cfg = get_config()
    if not cfg.api_key:
        raise RuntimeError("Retrace API key required. Call retrace.configure(api_key='rt_live_...') or set RETRACE_API_KEY. Get yours at https://retrace.yashbogam.me/settings")
    return cfg.api_key
