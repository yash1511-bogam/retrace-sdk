from .config import configure, get_config
from .recorder import record, TraceRecorder
from .trace import Span, Trace, SpanType, TraceStatus
from .errors import RetraceError, RetraceAuthError, RetraceCreditsExhaustedError, RetraceConnectionError, RetraceRateLimitError
from .interceptors.gemini import install_gemini_interceptor, uninstall_gemini_interceptor
from .interceptors.openai import install_openai_interceptor, uninstall_openai_interceptor
from .interceptors.anthropic import install_anthropic_interceptor, uninstall_anthropic_interceptor
from .replay import is_replaying, consume_cassette_entry

__version__ = "0.3.2"
__all__ = [
    "configure", "get_config",
    "record", "TraceRecorder",
    "Span", "Trace", "SpanType", "TraceStatus",
    "RetraceError", "RetraceAuthError", "RetraceCreditsExhaustedError", "RetraceConnectionError", "RetraceRateLimitError",
    "install_gemini_interceptor", "uninstall_gemini_interceptor",
    "install_openai_interceptor", "uninstall_openai_interceptor",
    "install_anthropic_interceptor", "uninstall_anthropic_interceptor",
    "is_replaying", "consume_cassette_entry",
]
