import { describe, it, expect, vi } from "vitest";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { ApiError, chat, confirm, createSession, type SanitizerDeps, type SessionStore, type UiEvent } from "./core.js";
import { decodeEventStream, harnessRequestBody, type HarnessEvent, type HarnessMessage } from "./harness.js";
import { parseToolCallResponse } from "./user-gateway.js";
import { ALLOWED_TOOLS } from "../shared/tools.js";
import type { PendingHold, SessionItem } from "../shared/schema.js";
import type { Caller } from "../shared/caller.js";

const NOW = new Date("2026-11-26T06:00:00Z");
const ALICE: Caller = { sub: "alice", pharmacy_id: "PH-001", role: "staff" };
const SID = "rx-00000000-0000-4000-8000-000000000001";
const SID2 = "rx-00000000-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------- fakes
function memorySessions(): SessionStore & { rows: Map<string, SessionItem> } {
  const rows = new Map<string, SessionItem>();
  return {
    rows,
    async create(item) {
      if (rows.has(item.session_id)) throw new Error("exists");
      rows.set(item.session_id, { ...item });
    },
    async get(id) {
      return rows.get(id);
    },
    async setPending(id, pending: PendingHold) {
      const r = rows.get(id);
      if (!r || r.pending || r.revoked) throw new Error("condition failed");
      r.pending = pending;
    },
    async claimPending(id, toolUseId) {
      const r = rows.get(id);
      if (!r || r.revoked || r.pending?.tool_use_id !== toolUseId) return undefined;
      const p = r.pending;
      delete r.pending;
      return p;
    },
    async revoke(id) {
      const r = rows.get(id)!;
      r.revoked = true;
      delete r.pending;
    },
  };
}

// Harness stream builders (event shapes as in the InvokeHarness docs/SDK).
const ev = (type: string, body: Record<string, unknown>): HarnessEvent => ({ type, body });
const textTurn = (text: string, stop = "end_turn"): HarnessEvent[] => [
  ev("messageStart", { role: "assistant" }),
  ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
  ev("contentBlockStop", { contentBlockIndex: 0 }),
  ev("messageStop", { stopReason: stop }),
];
const toolTurn = (...uses: { id: string; name: string; input: object }[]): HarnessEvent[] => [
  ev("messageStart", { role: "assistant" }),
  ...uses.flatMap((u, i) => {
    const json = JSON.stringify(u.input);
    return [
      ev("contentBlockStart", { contentBlockIndex: i, start: { toolUse: { toolUseId: u.id, name: u.name } } }),
      ev("contentBlockDelta", { contentBlockIndex: i, delta: { toolUse: { input: json.slice(0, 5) } } }),
      ev("contentBlockDelta", { contentBlockIndex: i, delta: { toolUse: { input: json.slice(5) } } }),
      ev("contentBlockStop", { contentBlockIndex: i }),
    ];
  }),
  ev("messageStop", { stopReason: "tool_use" }),
];

function setup(turns: HarnessEvent[][], caller: Caller = ALICE) {
  const sessions = memorySessions();
  const sent: HarnessMessage[][] = [];
  const invoke = vi.fn(async function* (_t: string, _s: string, messages: HarnessMessage[]) {
    sent.push(messages);
    for (const e of turns.shift() ?? []) yield e;
  });
  const callUserTool = vi.fn(async (_t: string, tool: string, args: Record<string, unknown>) =>
    tool.endsWith("create_hold") ? { ok: true, hold_id: "HOLD-1", status: "PENDING", echo: args } : { ok: true, holds: [] },
  );
  let n = 0;
  const deps: SanitizerDeps = {
    async verify(auth) {
      if (auth !== "Bearer good") throw new ApiError(401, "UNAUTHENTICATED", "Sign in first.");
      return { caller, token: "good" };
    },
    sessions,
    invoke,
    callUserTool,
    userTools: { createHold: "rxgrid-create-hold___create_hold", listHolds: "rxgrid-list-holds___list_holds" },
    now: () => NOW,
    newSessionId: () => [SID, SID2][n++]!,
  };
  const events: UiEvent[] = [];
  return { deps, sessions, sent, invoke, callUserTool, events, emit: (e: UiEvent) => events.push(e) };
}

const chatBody = (text: string, extra: object = {}) => JSON.stringify({ sessionId: SID, text, ...extra });

// ---------------------------------------------------------------------------- tests
describe("sanitizer: sessions and request allowlist", () => {
  it("L1: refuses requests without a valid token", async () => {
    const t = setup([]);
    await expect(createSession(t.deps, undefined)).rejects.toMatchObject({ status: 401 });
  });

  it("creates a session row holding the token's identity (what the hooks read)", async () => {
    const t = setup([]);
    expect(await createSession(t.deps, "Bearer good")).toEqual({ sessionId: SID });
    expect(t.sessions.rows.get(SID)).toMatchObject({ pharmacy_id: "PH-001", role: "staff", sub: "alice" });
  });

  it("L2: refuses unknown fields such as tools, skills, model, systemPrompt or toolResult", async () => {
    const t = setup([]);
    await createSession(t.deps, "Bearer good");
    for (const extra of [{ tools: [] }, { skills: [] }, { model: { modelId: "x" } }, { systemPrompt: "x" }, { toolResult: {} }]) {
      await expect(chat(t.deps, "Bearer good", chatBody("hi", extra), t.emit)).rejects.toMatchObject({ code: "UNEXPECTED_FIELDS" });
    }
    expect(t.invoke).not.toHaveBeenCalled();
  });

  it("sends only the user's text and the pinned allowedTools", async () => {
    const t = setup([textTurn("Two pharmacies have Dolo 650.")]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("  Who has Dolo 650?  "), t.emit);
    expect(t.sent[0]).toEqual([{ role: "user", content: [{ text: "Who has Dolo 650?" }] }]);
    expect(Object.keys(harnessRequestBody(t.sent[0]!))).toEqual(["messages", "allowedTools"]);
    expect(harnessRequestBody([]).allowedTools).toEqual([...ALLOWED_TOOLS]);
    expect(ALLOWED_TOOLS).not.toContain("*");
    expect(t.events).toEqual([
      { type: "accepted" },
      { type: "text", delta: "Two pharmacies have Dolo 650." },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("refuses someone else's session, and a session whose role changed", async () => {
    const t = setup([]);
    await createSession(t.deps, "Bearer good");
    const bob = setup([], { sub: "bob", pharmacy_id: "PH-003", role: "pharmacist" });
    bob.deps.sessions = t.sessions;
    await expect(chat(bob.deps, "Bearer good", chatBody("hi"), bob.emit)).rejects.toMatchObject({ status: 403 });
    const promoted = setup([], { ...ALICE, role: "pharmacist" });
    promoted.deps.sessions = t.sessions;
    await expect(chat(promoted.deps, "Bearer good", chatBody("hi"), promoted.emit)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses over-long text", async () => {
    const t = setup([]);
    await createSession(t.deps, "Bearer good");
    await expect(chat(t.deps, "Bearer good", chatBody("x".repeat(2001)), t.emit)).rejects.toMatchObject({ code: "TEXT_TOO_LONG" });
  });
});

describe("sanitizer: inline functions", () => {
  it("C2: runs list_holds with the user's token and resumes the agent with the result", async () => {
    const t = setup([toolTurn({ id: "t1", name: "list_holds", input: { pharmacy_id: "PH-001" } }), textTurn("You have no holds.")]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("show my holds"), t.emit);
    expect(t.callUserTool).toHaveBeenCalledWith("good", "rxgrid-list-holds___list_holds", { pharmacy_id: "PH-001" });
    const resumed = t.sent[1]![0]!.content[0] as any;
    expect(resumed.toolResult).toMatchObject({ toolUseId: "t1", status: "success" });
    expect(t.events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("C3: stops at create_hold for a human Confirm; a second hold in the same turn is not run", async () => {
    const hold = { pharmacy_id: "PH-001", source_pharmacy_id: "PH-002", drug_id: "D1", batch: "B1", qty: 50, schedule: "OTC" };
    const t = setup([
      toolTurn({ id: "h1", name: "create_hold", input: hold }, { id: "h2", name: "create_hold", input: { ...hold, batch: "B2" } }),
      textTurn("Placed one hold."),
    ]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("get 100"), t.emit);
    expect(t.callUserTool).not.toHaveBeenCalled();
    expect(t.events).toContainEqual({ type: "confirm", toolUseId: "h1", hold });
    expect(t.sessions.rows.get(SID)!.pending).toMatchObject({ tool_use_id: "h1", handoff_tool_use_ids: ["h1", "h2"] });

    // No new chat while a hold is pending.
    await expect(chat(t.deps, "Bearer good", chatBody("never mind"), t.emit)).rejects.toMatchObject({ code: "HOLD_PENDING" });

    await confirm(t.deps, "Bearer good", JSON.stringify({ sessionId: SID, toolUseId: "h1", approve: true }), t.emit);
    expect(t.callUserTool).toHaveBeenCalledTimes(1);
    expect(t.callUserTool).toHaveBeenCalledWith("good", "rxgrid-create-hold___create_hold", { ...hold, harness_session_id: SID });
    const results = t.sent[1]![0]!.content.map((c: any) => [c.toolResult.toolUseId, c.toolResult.status]);
    expect(results).toEqual([
      ["h1", "success"],
      ["h2", "error"],
    ]);

    // Replay / double click: nothing left to claim.
    await expect(
      confirm(t.deps, "Bearer good", JSON.stringify({ sessionId: SID, toolUseId: "h1", approve: true }), t.emit),
    ).rejects.toMatchObject({ code: "NO_PENDING_HOLD" });
    expect(t.callUserTool).toHaveBeenCalledTimes(1);
  });

  it("decline sends an error result and never calls the User Gateway", async () => {
    const t = setup([toolTurn({ id: "h1", name: "create_hold", input: { qty: 5 } }), textTurn("OK, not placed.")]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("hold 5"), t.emit);
    await confirm(t.deps, "Bearer good", JSON.stringify({ sessionId: SID, toolUseId: "h1", approve: false }), t.emit);
    expect(t.callUserTool).not.toHaveBeenCalled();
    expect((t.sent[1]![0]!.content[0] as any).toolResult.status).toBe("error");
  });

  it("refuses a confirm for a tool use that is not the pending one", async () => {
    const t = setup([toolTurn({ id: "h1", name: "create_hold", input: { qty: 5 } })]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("hold 5"), t.emit);
    await expect(
      confirm(t.deps, "Bearer good", JSON.stringify({ sessionId: SID, toolUseId: "forged", approve: true }), t.emit),
    ).rejects.toMatchObject({ code: "NO_PENDING_HOLD" });
  });
});

describe("sanitizer: hook_stopped", () => {
  it("E5: revokes the session after hook_stopped and issues a new one", async () => {
    const t = setup([
      [
        ev("messageStart", {}),
        ev("hookEvent", { name: "rxgrid_result_guard", type: "after_tool_call", decision: "deny", reason: "prompt injection" }),
        ev("messageStop", { stopReason: "hook_stopped" }),
      ],
    ]);
    await createSession(t.deps, "Bearer good");
    await chat(t.deps, "Bearer good", chatBody("find alprax"), t.emit);
    expect(t.sessions.rows.get(SID)!.revoked).toBe(true);
    expect(t.events).toContainEqual(expect.objectContaining({ type: "hook", decision: "deny" }));
    expect(t.events).toContainEqual(expect.objectContaining({ type: "session", sessionId: SID2 }));
    await expect(chat(t.deps, "Bearer good", chatBody("again"), t.emit)).rejects.toMatchObject({ status: 403 });
  });
});

describe("harness event-stream decoding", () => {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const frame = (headers: Record<string, string>, body: object) =>
    codec.encode({
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, { type: "string", value: v }])),
      body: fromUtf8(JSON.stringify(body)),
    });
  async function* chunked(bytes: Uint8Array, size: number) {
    for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
  }
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  };

  it("decodes events split at arbitrary byte boundaries", async () => {
    const bytes = concat([
      frame({ ":message-type": "event", ":event-type": "contentBlockDelta" }, { contentBlockIndex: 0, delta: { text: "hi" } }),
      frame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "end_turn" }),
    ]);
    for (const size of [1, 7, 64, 4096]) {
      const got: HarnessEvent[] = [];
      for await (const e of decodeEventStream(chunked(bytes, size))) got.push(e);
      expect(got.map((e) => e.type)).toEqual(["contentBlockDelta", "messageStop"]);
      expect(got[0]!.body.delta.text).toBe("hi");
    }
  });

  it("throws on an exception frame so a failed turn never looks clean", async () => {
    const bytes = frame({ ":message-type": "exception", ":exception-type": "validationException" }, { message: "bad" });
    await expect(async () => {
      for await (const _ of decodeEventStream(chunked(bytes, 16))) void _;
    }).rejects.toThrow(/validationException/);
  });
});

describe("User Gateway response parsing", () => {
  it("unwraps the tool Lambda's JSON from MCP text content (JSON and SSE)", () => {
    const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"ok":true,"hold_id":"H"}' }] } };
    expect(parseToolCallResponse(JSON.stringify(rpc), "application/json")).toEqual({ ok: true, hold_id: "H" });
    expect(parseToolCallResponse(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, "text/event-stream")).toEqual({
      ok: true,
      hold_id: "H",
    });
    expect(parseToolCallResponse('{"jsonrpc":"2.0","id":1,"error":{"message":"denied"}}', "application/json")).toMatchObject({ ok: false });
  });
});
