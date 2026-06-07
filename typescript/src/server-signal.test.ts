import { describe, it, expect, vi } from "vitest";
import { classifyServerSignal } from "./errors.js";
import { WSTransport } from "./transport.js";

// Tests exercise WSTransport's private signal-surfacing policy. Cast through a precise accessor type
// (not `any`) to reach the private members without loosening type-safety.
type Internals = {
  surfaceSignal(signal: ReturnType<typeof classifyServerSignal>): void;
  warnUnknownType(type: string): void;
};

describe("classifyServerSignal (structured, not string-match)", () => {
  it("credits_exhausted: 'limit reached' → not retryable, not fatal", () => {
    const s = classifyServerSignal("error", "Monthly trace limit reached");
    expect(s.code).toBe("credits_exhausted");
    expect(s.retryable).toBe(false);
    expect(s.fatal).toBe(false);
  });
  it("rate_limited → retryable, not fatal (user should back off)", () => {
    const s = classifyServerSignal("error", "Rate limit exceeded");
    expect(s.code).toBe("rate_limited");
    expect(s.retryable).toBe(true);
    expect(s.fatal).toBe(false);
  });
  it("halt → fatal (recording stopped), not retryable", () => {
    const s = classifyServerSignal("halt", "Cost budget exceeded");
    expect(s.code).toBe("halt");
    expect(s.fatal).toBe(true);
    expect(s.retryable).toBe(false);
  });
  it("unrecognized error text → generic error, not retryable/fatal", () => {
    const s = classifyServerSignal("error", "something odd");
    expect(s.code).toBe("error");
    expect(s.retryable).toBe(false);
    expect(s.fatal).toBe(false);
  });
});

describe("WSTransport.surfaceSignal (onError policy)", () => {
  it("hands the STRUCTURED signal to onError (no string-matching needed)", () => {
    const t = new WSTransport();
    const cb = vi.fn();
    t.onError = cb;
    (t as unknown as Internals).surfaceSignal(classifyServerSignal("error", "Rate limit exceeded"));
    expect(cb).toHaveBeenCalledOnce();
    const sig = cb.mock.calls[0][0];
    expect(sig.code).toBe("rate_limited");
    expect(sig.retryable).toBe(true);
  });

  it("a THROWING onError does not propagate — the listener survives", () => {
    const t = new WSTransport();
    t.onError = () => { throw new Error("user callback bug"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => (t as unknown as Internals).surfaceSignal(classifyServerSignal("halt", "x"))).not.toThrow();
    expect(warn).toHaveBeenCalled(); // the throw is reported, not swallowed
    warn.mockRestore();
  });

  it("no callback ⇒ default warn, THROTTLED (2nd same-code within 5s suppressed)", () => {
    const t = new WSTransport(); // onError undefined
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (t as unknown as Internals).surfaceSignal(classifyServerSignal("error", "Rate limit exceeded"));
    (t as unknown as Internals).surfaceSignal(classifyServerSignal("error", "Rate limit exceeded"));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("unknown server message type ⇒ throttled warn (F-P6: never silently swallowed)", () => {
    const t = new WSTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (t as unknown as Internals).warnUnknownType("zzz_future_type");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("zzz_future_type");
    warn.mockRestore();
  });
});
