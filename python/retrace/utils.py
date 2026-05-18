import json
from datetime import datetime, timezone
from uuid import uuid4


def gen_id() -> str:
    return str(uuid4())


def now_iso() -> str:
    return utcnow().isoformat().replace("+00:00", "Z")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def truncate_json(obj, max_bytes: int = 10240):
    try:
        s = json.dumps(obj)
        if len(s.encode()) <= max_bytes:
            return obj
        return json.loads(s.encode()[:max_bytes].decode(errors="ignore"))
    except (TypeError, ValueError):
        return str(obj)[:max_bytes]
