import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, HARNESS_GATEWAY_TOOL, INLINE_TOOLS, SEARCH_GATEWAY_TOOL } from "./tools.js";

// CreateHarness / InvokeHarness: each allowedTools entry is 1-64 chars, pattern (*|@?[^/]+(/[^/]+)?).
const SELECTOR = /^(\*|@?[^/]+(\/[^/]+)?)$/;

describe("ALLOWED_TOOLS", () => {
  it("is exactly the gateway search tool plus the two inline functions", () => {
    expect([...ALLOWED_TOOLS]).toEqual([
      `@${HARNESS_GATEWAY_TOOL}/${SEARCH_GATEWAY_TOOL}`,
      `@${INLINE_TOOLS.createHold}`,
      `@${INLINE_TOOLS.listHolds}`,
    ]);
  });

  it("meets the documented selector length and pattern", () => {
    for (const s of ALLOWED_TOOLS) {
      expect(s.length).toBeGreaterThanOrEqual(1);
      expect(s.length).toBeLessThanOrEqual(64);
      expect(s).toMatch(SELECTOR);
    }
  });

  it("has no wildcard and no built-in selector (shell, read, write, @builtin)", () => {
    for (const s of ALLOWED_TOOLS) {
      expect(s).not.toContain("*");
      expect(s.startsWith("@")).toBe(true); // a plain name selects built-ins only
      expect(s.startsWith("@builtin")).toBe(false);
    }
  });
});
