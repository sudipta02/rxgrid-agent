/**
 * Sanitizer API core (layer L2): the only path from a browser to InvokeHarness.
 *
 *   POST /sessions                           -> new server-generated session, Sessions row
 *   POST /chat     { sessionId, text }       -> one user turn, streamed as UiEvents
 *   POST /confirm  { sessionId, toolUseId, approve } -> resolve the pending create_hold
 *
 * Rules:
 *   - Identity comes only from the verified Cognito access token. A session is usable only
 *     by the same sub, pharmacy and role that created it.
 *   - Requests are built from an ALLOWLIST: user text becomes one text block; nothing else
 *     the client sends is forwarded. Unknown body fields are rejected (400), so attempts to
 *     pass tools/skills/model/systemPrompt/toolResult are refused and logged, not ignored.
 *   - A toolResult is built ONLY here, from a User Gateway response, after a human Confirm
 *     (create_hold) or automatically (list_holds). Never from client input.
 *   - A pending hold is claimed with a conditional update, so it runs at most once.
 *   - hook_stopped revokes the session (its history may hold a poisoned tool result) and
 *     issues a new one.
 */
import { randomUUID } from "node:crypto";
import { SESSION_TTL_SECONDS, type PendingHold, type SessionItem } from "../shared/schema.js";
import { INLINE_TOOLS, isInlineTool } from "../shared/tools.js";
import type { Caller } from "../shared/caller.js";
import type { HarnessContentBlock, HarnessEvent, HarnessMessage, InvokeHarness } from "./harness.js";
import type { CallUserTool } from "./user-gateway.js";

// ----------------------------------------------------------------------------- types
export type UiEvent =
  /** Sent as soon as a request passes validation: opens the stream within API Gateway 29 s first-byte limit. */
  | { type: "accepted" }
  | { type: "session"; sessionId: string; reason?: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "hook"; name: string; hookType: string; decision?: string; reason?: string }
  | { type: "confirm"; toolUseId: string; hold: Record<string, unknown> }
  | { type: "hold_result"; result: Record<string, unknown> }
  | { type: "done"; stopReason: string }
  | { type: "error"; code: string; message: string };

export type Emit = (e: UiEvent) => void;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionStore {
  create(item: SessionItem): Promise<void>;
  get(sessionId: string): Promise<SessionItem | undefined>;
  /** Fails if a hold is already pending or the session is revoked. */
  setPending(sessionId: string, pending: PendingHold): Promise<void>;
  /** Atomically removes and returns the pending hold if its tool_use_id matches, else undefined. */
  claimPending(sessionId: string, toolUseId: string): Promise<PendingHold | undefined>;
  revoke(sessionId: string): Promise<void>;
}

export interface SanitizerDeps {
  /** Verify `Authorization: Bearer <access token>`; throws ApiError(401) if invalid. */
  verify(authorization: string | undefined): Promise<{ caller: Caller; token: string }>;
  sessions: SessionStore;
  invoke: InvokeHarness;
  callUserTool: CallUserTool;
  /** User Gateway tool names ("<target>___<tool>"). */
  userTools: { createHold: string; listHolds: string };
  now(): Date;
  newSessionId?(): string;
}

export const MAX_TEXT_CHARS = 2000;
const MAX_ROUNDS = 4;
export const SESSION_ID_PATTERN = /^rx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_RUN = { ok: false, code: "NOT_RUN", message: "Not run: only one hold can be confirmed at a time. Ask again." };

// ----------------------------------------------------------------------------- body parsing
/** JSON object with only `allowed` keys. Anything else is refused, not stripped. */
export function parseBody(raw: string | null | undefined, allowed: readonly string[]): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(raw ?? "");
  } catch {
    throw new ApiError(400, "BAD_JSON", "Request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "BAD_JSON", "Request body must be a JSON object.");
  }
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw new ApiError(400, "UNEXPECTED_FIELDS", `Fields not accepted: ${extra.slice(0, 10).join(", ")}.`);
  }
  return body as Record<string, unknown>;
}

function sessionIdOf(body: Record<string, unknown>): string {
  const id = body.sessionId;
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) throw new ApiError(400, "BAD_SESSION_ID", "Invalid sessionId.");
  return id;
}

// ----------------------------------------------------------------------------- routes
export async function createSession(deps: SanitizerDeps, authorization: string | undefined) {
  const { caller } = await deps.verify(authorization);
  return { sessionId: await newSession(deps, caller) };
}

export async function chat(deps: SanitizerDeps, authorization: string | undefined, raw: string | null, emit: Emit) {
  const { caller, token } = await deps.verify(authorization);
  const body = parseBody(raw, ["sessionId", "text"]);
  const sessionId = sessionIdOf(body);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new ApiError(400, "EMPTY_TEXT", "Message text is required.");
  if (text.length > MAX_TEXT_CHARS) throw new ApiError(400, "TEXT_TOO_LONG", `Messages are limited to ${MAX_TEXT_CHARS} characters.`);

  const session = await loadOwnSession(deps, caller, sessionId);
  if (session.pending) throw new ApiError(409, "HOLD_PENDING", "Confirm or decline the pending hold first.");
  emit({ type: "accepted" });
  await runTurns(deps, caller, token, sessionId, [{ role: "user", content: [{ text }] }], emit);
}

export async function confirm(deps: SanitizerDeps, authorization: string | undefined, raw: string | null, emit: Emit) {
  const { caller, token } = await deps.verify(authorization);
  const body = parseBody(raw, ["sessionId", "toolUseId", "approve"]);
  const sessionId = sessionIdOf(body);
  if (typeof body.toolUseId !== "string" || typeof body.approve !== "boolean") {
    throw new ApiError(400, "BAD_CONFIRM", "toolUseId (string) and approve (boolean) are required.");
  }
  const session = await loadOwnSession(deps, caller, sessionId);
  if (session.pending?.tool_use_id !== body.toolUseId) throw new ApiError(409, "NO_PENDING_HOLD", "There is no such pending hold.");

  // Claim first: a double click or replay finds nothing to claim and is refused.
  const claimed = await deps.sessions.claimPending(sessionId, body.toolUseId);
  if (!claimed) throw new ApiError(409, "NO_PENDING_HOLD", "This hold was already confirmed or declined.");
  emit({ type: "accepted" });

  const result = body.approve
    ? await deps.callUserTool(token, deps.userTools.createHold, { ...claimed.input, harness_session_id: sessionId })
    : { ok: false, code: "DECLINED", message: "The user declined this hold. Do not retry it unless they ask." };
  emit({ type: "hold_result", result });

  const content = claimed.handoff_tool_use_ids.map((id) => toolResultBlock(id, id === claimed.tool_use_id ? result : NOT_RUN));
  await runTurns(deps, caller, token, sessionId, [{ role: "user", content }], emit);
}

// ----------------------------------------------------------------------------- internals
async function newSession(deps: SanitizerDeps, caller: Caller): Promise<string> {
  const sessionId = deps.newSessionId?.() ?? `rx-${randomUUID()}`;
  const now = deps.now();
  await deps.sessions.create({
    session_id: sessionId,
    pharmacy_id: caller.pharmacy_id,
    role: caller.role,
    sub: caller.sub,
    created_at: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  });
  return sessionId;
}

/** Same refusal for missing, expired, revoked and someone else's session: nothing to probe. */
async function loadOwnSession(deps: SanitizerDeps, caller: Caller, sessionId: string): Promise<SessionItem> {
  const s = await deps.sessions.get(sessionId);
  const valid =
    s &&
    !s.revoked &&
    s.ttl * 1000 > deps.now().getTime() &&
    s.sub === caller.sub &&
    s.pharmacy_id === caller.pharmacy_id &&
    s.role === caller.role;
  if (!valid) throw new ApiError(403, "SESSION_INVALID", "This conversation is not available. Start a new one.");
  return s;
}

export function toolResultBlock(toolUseId: string, result: Record<string, unknown>): HarnessContentBlock {
  return {
    toolResult: {
      toolUseId,
      status: result.ok === false ? "error" : "success",
      content: [{ text: JSON.stringify(result) }],
    },
  };
}

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

async function runTurns(
  deps: SanitizerDeps,
  caller: Caller,
  token: string,
  sessionId: string,
  messages: HarnessMessage[],
  emit: Emit,
): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const out = await consumeStream(deps.invoke(token, sessionId, messages), emit);

    if (out.stopReason === "hook_stopped") {
      await deps.sessions.revoke(sessionId);
      const next = await newSession(deps, caller);
      emit({ type: "session", sessionId: next, reason: "A safety check stopped this conversation, so a new one was started." });
      emit({ type: "done", stopReason: "hook_stopped" });
      return;
    }
    if (out.stopReason !== "tool_use") {
      emit({ type: "done", stopReason: out.stopReason ?? "unknown" });
      return;
    }

    const calls = out.toolUses.filter((t) => isInlineTool(t.name));
    if (calls.length === 0) {
      emit({ type: "error", code: "UNEXPECTED_HANDOFF", message: "The agent stopped for a tool this app does not run." });
      return;
    }
    const hold = calls.find((c) => c.name === INLINE_TOOLS.createHold);
    if (hold) {
      await deps.sessions.setPending(sessionId, {
        tool_use_id: hold.id,
        input: hold.input,
        handoff_tool_use_ids: calls.map((c) => c.id),
        created_at: deps.now().toISOString(),
      });
      emit({ type: "confirm", toolUseId: hold.id, hold: hold.input });
      emit({ type: "done", stopReason: "awaiting_confirmation" });
      return;
    }
    // Only list_holds: run each with the person's token, then resume the agent.
    const content: HarnessContentBlock[] = [];
    for (const c of calls) content.push(toolResultBlock(c.id, await deps.callUserTool(token, deps.userTools.listHolds, c.input)));
    messages = [{ role: "user", content }];
  }
  emit({ type: "error", code: "TOO_MANY_ROUNDS", message: "The agent took too many steps. Try a simpler request." });
}

/** Forward safe UI events; return the final stop reason and the last message's tool uses. */
export async function consumeStream(events: AsyncIterable<HarnessEvent>, emit: Emit) {
  let open = new Map<number, { id: string; name: string; json: string; input?: Record<string, unknown> }>();
  let msgTools: ToolUse[] = [];
  let toolUses: ToolUse[] = [];
  let stopReason: string | undefined;

  for await (const e of events) {
    const b = e.body ?? {};
    switch (e.type) {
      case "messageStart":
        open = new Map();
        msgTools = [];
        break;
      case "contentBlockStart": {
        const tu = b.start?.toolUse;
        if (tu?.toolUseId && tu?.name) {
          open.set(b.contentBlockIndex, {
            id: String(tu.toolUseId),
            name: String(tu.name),
            json: "",
            input: tu.input && typeof tu.input === "object" ? tu.input : undefined,
          });
          emit({ type: "tool", name: String(tu.name) });
        }
        break;
      }
      case "contentBlockDelta": {
        const d = b.delta ?? {};
        if (typeof d.text === "string") emit({ type: "text", delta: d.text });
        const t = open.get(b.contentBlockIndex);
        if (t && typeof d.toolUse?.input === "string") t.json += d.toolUse.input;
        break;
      }
      case "contentBlockStop": {
        const t = open.get(b.contentBlockIndex);
        if (t) {
          msgTools.push({ id: t.id, name: t.name, input: t.input ?? parseObject(t.json) });
          open.delete(b.contentBlockIndex);
        }
        break;
      }
      case "messageStop":
        stopReason = b.stopReason;
        toolUses = msgTools;
        break;
      case "hookEvent":
        emit({ type: "hook", name: String(b.name ?? ""), hookType: String(b.type ?? ""), decision: b.decision, reason: b.reason });
        break;
      default:
        break; // metadata and unknown events are not forwarded
    }
  }
  return { stopReason, toolUses };
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
