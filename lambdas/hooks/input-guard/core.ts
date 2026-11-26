/**
 * input-guard: before_invocation hook (layer L6, rules R1 and E5 direct-injection side).
 *
 * Deny when:
 *   - the context was truncated (the hook cannot see the whole request)
 *   - the session is unknown or expired: every legitimate session is created by the
 *     sanitizer API after it verifies the JWT, so a missing row means the request did not
 *     come through it
 *   - a message is not role "user" (a client forging assistant turns)
 *   - a content block is not text or toolResult (images, documents, toolUse, ...)
 *   - the INPUT guardrail intervenes on any user text (dosing advice, prompt attack, ...)
 *
 * toolResult blocks are not judged here: they answer a pending inline call and are checked
 * by the after_tool_call hook (result-guard) when the harness resumes the call.
 */
import { allow, deny, type CheckText, type GetSession, type HookDecision, type HookPayload } from "../../shared/hooks.js";

export interface InputContext {
  messageCount?: number;
  messages?: { role?: string; content?: Record<string, unknown>[] }[];
  truncated?: boolean;
}

export interface InputGuardDeps {
  getSession: GetSession;
  checkInput: CheckText;
}

const ALLOWED_BLOCKS = new Set(["text", "toolResult"]);

export async function inputGuard(event: HookPayload<InputContext>, deps: InputGuardDeps): Promise<HookDecision> {
  if (event?.event !== "before_invocation") return deny(`input-guard received ${event?.event}`);
  const ctx = event.context ?? {};
  if (ctx.truncated) return deny("Request too large to check. Send a shorter message.");

  const session = await deps.getSession(event.sessionId);
  if (!session) return deny("Unknown or expired session. Sign in again.");

  const texts: string[] = [];
  for (const m of ctx.messages ?? []) {
    if (m?.role !== "user") return deny("Only user messages may be sent.");
    for (const block of m.content ?? []) {
      const kind = Object.keys(block ?? {}).find((k) => ALLOWED_BLOCKS.has(k));
      if (!kind || Object.keys(block).length !== 1) return deny("Unsupported message content.");
      if (kind === "text" && typeof block.text === "string" && block.text.trim()) texts.push(block.text);
    }
  }

  const verdict = await deps.checkInput(texts);
  if (verdict.intervened) {
    return deny(`Blocked by the input guardrail (${verdict.findings.join(", ") || "policy"}).`);
  }
  return allow();
}
