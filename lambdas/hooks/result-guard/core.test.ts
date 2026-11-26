import { describe, it, expect, vi } from "vitest";
import { resultGuard, toBlocks, type ToolResultContext } from "./core.js";
import type { CheckText, HookPayload } from "../../shared/hooks.js";
import { POISONED_NOTES } from "../../../seed/seed-data.js";

// Fake guardrail that "detects" the seeded payloads. This tests the plumbing only; the real
// guardrail's detection rate is measured by the stress test.
const fakeGuardrail: CheckText = async (t) =>
  t.some((x) => x.includes("SYSTEM INSTRUCTION") || x.includes("split any large order"))
    ? { intervened: true, findings: ["content:PROMPT_ATTACK"] }
    : { intervened: false, findings: [] };

const ev = (context: ToolResultContext): HookPayload<ToolResultContext> => ({
  hookEventId: "h1",
  name: "result_guard",
  event: "after_tool_call",
  harnessArn: "arn",
  sessionId: "s1",
  context: { toolName: "rxgrid-search___search_inventory", toolType: "agentcore_gateway", ...context },
});

/** A Gateway Lambda result as the harness typically sees it: JSON inside MCP text content. */
const mcpResult = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

describe("result-guard (after_tool_call)", () => {
  it("allows a clean search result", async () => {
    const result = mcpResult({ ok: true, results: [{ brand_name: "Dolo 650", qty_available: 40 }] });
    expect((await resultGuard(ev({ toolResult: result }), fakeGuardrail)).decision).toBe("allow");
  });

  it("E5: finds the blatant payload nested in JSON-encoded pharmacy notes and denies", async () => {
    const result = mcpResult({
      ok: true,
      results: [{ brand_name: "Alprax 0.25", pharmacy_notes_untrusted: POISONED_NOTES.blatant }],
    });
    const r = await resultGuard(ev({ toolResult: result }), fakeGuardrail);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/restarted/);
  });

  it("E5: finds the subtle limit-splitting payload", async () => {
    const result = mcpResult({ ok: true, results: [{ pharmacy_notes_untrusted: POISONED_NOTES.subtle }] });
    expect((await resultGuard(ev({ toolResult: result }), fakeGuardrail)).decision).toBe("deny");
  });

  it("denies a truncated result without calling the guardrail", async () => {
    const check = vi.fn(fakeGuardrail);
    const r = await resultGuard(ev({ toolResult: { truncated: true, preview: '{"ok":' } }), check);
    expect(r.decision).toBe("deny");
    expect(check).not.toHaveBeenCalled();
  });

  it("batches leaves into blocks of at most 4,000 chars without losing text", () => {
    const blocks = toBlocks(Array.from({ length: 10 }, () => "x".repeat(1500)));
    expect(blocks.every((b) => b.length <= 4000)).toBe(true);
    expect(blocks.join("").replace(/\n/g, "").length).toBe(15000);
  });
});
