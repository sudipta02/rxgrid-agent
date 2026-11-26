/**
 * Helpers for Lambdas invoked as AgentCore Gateway targets.
 *
 * Gateway passes the tool arguments as the event, and metadata in
 * context.clientContext.custom:
 *   bedrockAgentCoreToolName          "<target>___<tool>"
 *   bedrockAgentCorePropagatedHeaders allow-listed request headers (if configured)
 * See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
 */

export interface GatewayContext {
  clientContext?: { custom?: Record<string, unknown> } | null;
}

/** The tool name without the "<target>___" prefix, or "" if absent. */
export function toolName(context: GatewayContext): string {
  const full = String(context.clientContext?.custom?.bedrockAgentCoreToolName ?? "");
  const i = full.indexOf("___");
  return i >= 0 ? full.slice(i + 3) : full;
}

/** Propagated headers as a lower-cased map. Accepts an object or a JSON string. */
export function propagatedHeaders(context: GatewayContext): Record<string, string> {
  let raw = context.clientContext?.custom?.bedrockAgentCorePropagatedHeaders;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/** Structured tool result. The model sees `ok`, a stable `code`, and a short message. */
export type ToolResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string; [k: string]: unknown };

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult<never> {
  return { ok: false, code, message, ...extra };
}

/** Thrown for anything the caller did wrong; turned into a ToolResult by the handler. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
