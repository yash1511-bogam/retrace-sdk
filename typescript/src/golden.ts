import { getConfig, requireApiKey } from "./config.js";

/**
 * Mark (or unmark) a recorded trace as a GOLDEN regression baseline (Phase 2E).
 * Golden traces are the reference for regression replay — `compareToGolden` flags structural
 * divergence in later runs as a regression.
 */
export async function markGolden(traceId: string, golden = true): Promise<void> {
  requireApiKey();
  const cfg = getConfig();
  const res = await fetch(`${cfg.baseUrl}/api/v1/traces/${traceId}/golden`, {
    method: "POST",
    headers: { "x-retrace-key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ golden }),
  });
  if (!res.ok) throw new Error(`markGolden failed: HTTP ${res.status}`);
}
