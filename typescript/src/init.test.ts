import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure } from "./config.js";

// Stub the transport so the ambient recorder never opens a socket.
vi.mock("./transport.js", () => ({
  createTransport: () => ({ send: vi.fn(), close: vi.fn(), flush: vi.fn() }),
  registerProcessExitFlush: vi.fn(),
  onProcessExit: vi.fn(),
}));

import { init, getActiveRecorder, shutdown } from "./init.js";

describe("init (zero-config)", () => {
  beforeEach(() => { shutdown(); configure({ apiKey: "", enabled: true }); });

  it("throws a helpful error without an API key", () => {
    configure({ apiKey: "" });
    expect(() => init({ autoTrace: false })).toThrow(/API key/);
  });

  it("returns null when disabled", () => {
    configure({ apiKey: "rt_live_test", enabled: false });
    expect(init()).toBeNull();
  });

  it("auto-starts an ambient trace and shuts down idempotently", () => {
    configure({ apiKey: "rt_live_test", enabled: true });
    const rec = init({ name: "unit-agent" });
    expect(rec).not.toBeNull();
    expect(getActiveRecorder()).toBe(rec);
    expect(rec!.traceId).toBeTruthy();
    shutdown("done");
    expect(getActiveRecorder()).toBeNull();
    shutdown(); // idempotent — no throw
  });

  it("is a singleton — repeated init returns the same recorder", () => {
    configure({ apiKey: "rt_live_test", enabled: true });
    const a = init({ name: "x" });
    const b = init({ name: "y" });
    expect(a).toBe(b);
    shutdown();
  });
});
