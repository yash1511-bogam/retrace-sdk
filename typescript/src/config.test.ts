import { describe, it, expect } from "vitest";
import { configure, getConfig } from "./config.js";

describe("SDK config", () => {
  it("has defaults", () => {
    const c = getConfig();
    expect(c.baseUrl).toBe("http://localhost:3001");
    expect(c.enabled).toBe(true);
  });
  it("configures custom values", () => {
    configure({ apiKey: "rt_live_test", baseUrl: "http://custom:3001" });
    const c = getConfig();
    expect(c.apiKey).toBe("rt_live_test");
    expect(c.baseUrl).toBe("http://custom:3001");
  });
});
