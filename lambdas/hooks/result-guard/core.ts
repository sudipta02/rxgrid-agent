/**
 * result-guard: after_tool_call hook (layer L6, rule E5: indirect prompt injection).
 *
 * Checks every string in the tool result (recursing into JSON-encoded strings, which is how
 * Lambda/MCP results usually arrive) with the TOOL-RESULT guardrail: prompt-attack filter
 * only, so stock data is not judged against the dosing-advice topic.
 *
 * Deny when the result is truncated or the guardrail intervenes. A deny KEEPS the completed
 * result in session history and stops the invocation (stopReason "hook_stopped"), so the
 * sanitizer must start a new session after it (DOCS-CHECK item 3).
 *
 * For inline functions the result is client-supplied (only the backend's post-confirm path
 * may send one). It is checked the same way; this hook does not attest that the action ran.
 */
import { allow, deny, isTruncatedField, stringLeaves, type CheckText, type HookDecision, type HookPayload } from "../../shared/hooks.js";

export interface ToolResultContext {
  toolName?: string;
  toolType?: string;
  toolUseId?: string;
  toolResult?: unknown;
  error?: string;
}

/** ApplyGuardrail accepts many blocks per call; batch leaves into ~4,000-char blocks. */
const BLOCK_CHARS = 4000;

export function toBlocks(leaves: string[]): string[] {
  const blocks: string[] = [];
  let cur = "";
  for (const leaf of leaves) {
    if (cur && cur.length + leaf.length + 1 > BLOCK_CHARS) {
      blocks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${leaf}` : leaf;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

export async function resultGuard(event: HookPayload<ToolResultContext>, checkResult: CheckText): Promise<HookDecision> {
  if (event?.event !== "after_tool_call") return deny(`result-guard received ${event?.event}`);
  const ctx = event.context ?? {};
  if (isTruncatedField(ctx.toolResult) || isTruncatedField(ctx.error)) {
    return deny("Tool result too large to check; the session must be restarted.");
  }
  const leaves = stringLeaves([ctx.toolResult, ctx.error]);
  const verdict = await checkResult(toBlocks(leaves));
  if (verdict.intervened) {
    return deny(
      `Tool result from ${ctx.toolName ?? "a tool"} looks like a prompt injection (${verdict.findings.join(", ") || "policy"}). ` +
        "Stopped; the session must be restarted.",
    );
  }
  return allow();
}
