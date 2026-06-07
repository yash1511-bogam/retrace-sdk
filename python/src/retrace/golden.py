"""Golden trace marking (Phase 2E) for regression replay."""
from .config import get_config


def mark_golden(trace_id: str, golden: bool = True) -> None:
    """Mark (or unmark) a recorded trace as a GOLDEN regression baseline.

    Golden traces are the reference for regression replay — later runs that structurally
    diverge from their golden baseline are flagged as regressions.
    """
    import requests

    cfg = get_config()
    if not cfg.api_key:
        raise RuntimeError("Retrace API key required. Call retrace.configure(api_key='rt_live_...').")
    resp = requests.post(
        f"{cfg.base_url}/api/v1/traces/{trace_id}/golden",
        json={"golden": golden},
        headers={"x-retrace-key": cfg.api_key, "Content-Type": "application/json"},
        timeout=10,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"mark_golden failed: HTTP {resp.status_code}")
