import { describe, it, expect } from "vitest";
import { toolCap, type GetDailyUsage, type ToolCallContext } from "./core.js";
import type { GetSession, HookPayload } from "../../shared/hooks.js";

const staff: GetSession = async () => ({ pharmacy_id: "PH-001", role: "staff", sub: "u1" });
const pharmacist: GetSession = async () => ({ pharmacy_id: "PH-001", role: "pharmacist", sub: "u2" });
const noSession: GetSession = async () => undefined;
const usage =
  (units_total: number, hold_count: number): GetDailyUsage =>
  async () => ({ units_total, hold_count });
const none: GetDailyUsage = async () => undefined;
const now = () => new Date("2026-11-26T06:00:00Z");

const ev = (context: ToolCallContext): HookPayload<ToolCallContext> => ({
  hookEventId: "h1",
  name: "tool_cap",
  event: "before_tool_call",
  harnessArn: "arn",
  sessionId: "s1",
  context,
});
const hold = (input: Record<string, unknown>) =>
  ev({
    toolName: "create_hold",
    toolType: "inline_function",
    toolInput: { pharmacy_id: "PH-001", qty: 10, schedule: "OTC", ...input },
  });

describe("tool-cap (before_tool_call)", () => {
  it("allows the gateway search tool", async () => {
    const r = await toolCap(ev({ toolName: "rxgrid-search___search_inventory", toolType: "agentcore_gateway" }), {
      getSession: noSession,
      getDailyUsage: none,
      now,
    });
    expect(r.decision).toBe("allow");
  });

  it("denies built-in tools such as shell even if allowedTools were misconfigured", async () => {
    for (const [toolName, toolType] of [
      ["shell", "builtin"],
      ["write", "builtin"],
      ["search_inventory", "builtin"],
      ["create_hold", "agentcore_gateway"],
    ] as const) {
      const r = await toolCap(ev({ toolName, toolType }), { getSession: staff, getDailyUsage: none, now });
      expect(r.decision, `${toolName}/${toolType}`).toBe("deny");
    }
  });

  it("C3: allows a hold within all limits", async () => {
    const r = await toolCap(hold({}), { getSession: staff, getDailyUsage: usage(40, 2), now });
    expect(r.decision).toBe("allow");
  });

  it("C2/R5: denies a hold or a listing for another pharmacy", async () => {
    expect((await toolCap(hold({ pharmacy_id: "PH-003" }), { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
    const list = ev({ toolName: "list_holds", toolType: "inline_function", toolInput: { pharmacy_id: "PH-003" } });
    expect((await toolCap(list, { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
  });

  it("E4: denies over 50 units and points to a handoff, not splitting", async () => {
    const r = await toolCap(hold({ qty: 51 }), { getSession: staff, getDailyUsage: none, now });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/handoff/);
  });

  it("denies non-integer and zero quantities", async () => {
    for (const qty of [0, 2.5, "10"]) {
      expect((await toolCap(hold({ qty }), { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
    }
  });

  it("R2: denies H1/X for staff, allows them for a pharmacist", async () => {
    expect((await toolCap(hold({ schedule: "X" }), { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
    expect((await toolCap(hold({ schedule: "H1" }), { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
    expect((await toolCap(hold({ schedule: "X" }), { getSession: pharmacist, getDailyUsage: none, now })).decision).toBe("allow");
  });

  it("C3/E4: denies when the day's units or hold count would pass the cap (limit splitting)", async () => {
    expect((await toolCap(hold({ qty: 50 }), { getSession: staff, getDailyUsage: usage(110, 3), now })).decision).toBe("deny");
    expect((await toolCap(hold({ qty: 1 }), { getSession: staff, getDailyUsage: usage(10, 10), now })).decision).toBe("deny");
    expect((await toolCap(hold({ qty: 50 }), { getSession: staff, getDailyUsage: usage(100, 3), now })).decision).toBe("allow");
  });

  it("denies inline calls without a session, and truncated input", async () => {
    expect((await toolCap(hold({}), { getSession: noSession, getDailyUsage: none, now })).decision).toBe("deny");
    const t = ev({ toolName: "create_hold", toolType: "inline_function", toolInput: { truncated: true, preview: "{" } });
    expect((await toolCap(t, { getSession: staff, getDailyUsage: none, now })).decision).toBe("deny");
  });
});
