/**
 * Shared types and helpers for AgentCore harness lifecycle-hook Lambdas (layer L6).
 *
 * Contract (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html):
 *   - The harness execution role invokes the Lambda synchronously with the payload below.
 *   - The Lambda returns { decision: "allow" | "deny", reason? } (reason <= 1,024 chars).
 *   - A timeout, error or invalid response applies failureMode (configure "deny").
 *   - Context truncation does NOT trigger failureMode, so every hook denies truncated
 *     context itself: a hook that cannot see everything must not allow it.
 *   - Payloads carry no JWT claims, only sessionId; identity comes from the Sessions table.
 */
import type { Role } from "./schema.js";

export type HookEventName = "before_invocation" | "before_tool_call" | "after_tool_call" | "after_invocation";

export interface HookPayload<C = Record<string, unknown>> {
  hookEventId: string;
  name: string;
  event: HookEventName;
  harnessArn: string;
  sessionId: string;
  context: C;
}

export interface HookDecision {
  decision: "allow" | "deny";
  reason?: string;
}

const MAX_REASON = 1024;

export function allow(reason?: string): HookDecision {
  return reason ? { decision: "allow", reason: reason.slice(0, MAX_REASON) } : { decision: "allow" };
}

export function deny(reason: string): HookDecision {
  return { decision: "deny", reason: reason.slice(0, MAX_REASON) };
}

/** A field the harness replaced to fit the 64 KiB limit: { truncated: true, preview }. */
export function isTruncatedField(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as Record<string, unknown>).truncated === true;
}

/** Identity the sanitizer stored for this harness session after verifying the JWT. */
export interface SessionIdentity {
  pharmacy_id: string;
  role: Role;
  sub: string;
}

/** Look up the session; undefined if absent or expired (DynamoDB TTL deletes lazily). */
export type GetSession = (sessionId: string) => Promise<SessionIdentity | undefined>;

/** Result of ApplyGuardrail, reduced to what a hook needs. */
export interface GuardrailVerdict {
  intervened: boolean;
  /** Policy names that fired, e.g. "topic:DosingAdvice", "content:PROMPT_ATTACK". */
  findings: string[];
}

export type CheckText = (texts: string[]) => Promise<GuardrailVerdict>;

/** Every string leaf in a value, recursing into arrays, objects and JSON-encoded strings. */
export function stringLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return out;
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return stringLeaves(JSON.parse(s), out, depth + 1);
      } catch {
        /* not JSON: keep as text */
      }
    }
    out.push(s);
  } else if (Array.isArray(v)) {
    for (const x of v) stringLeaves(x, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) stringLeaves(x, out, depth + 1);
  }
  return out;
}
