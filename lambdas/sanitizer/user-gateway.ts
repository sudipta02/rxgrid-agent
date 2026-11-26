/**
 * Calls a User Gateway tool (MCP tools/call over streamable HTTP) with the signed-in
 * person's Cognito access token. The same token goes in two places:
 *   Authorization: Bearer   -> the Gateway's CUSTOM_JWT authorizer and Cedar (principal tags)
 *   x-rxgrid-user-token     -> propagated to the Lambda, which re-verifies it
 * The model never sees this request; it only sees the toolResult the sanitizer builds.
 */
import { USER_TOKEN_HEADER } from "../shared/caller.js";

export type CallUserTool = (token: string, toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function userGatewayCaller(gatewayUrl: string): CallUserTool {
  return async (token, toolName, args) => {
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        [USER_TOKEN_HEADER]: token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    });
    const raw = await res.text();
    if (!res.ok) {
      // 401/403 here are the JWT authorizer or Cedar (in ENFORCE mode) refusing the call.
      return { ok: false, code: res.status === 403 ? "POLICY_DENIED" : "GATEWAY_ERROR", message: `User Gateway returned ${res.status}.` };
    }
    return parseToolCallResponse(raw, res.headers.get("content-type") ?? "");
  };
}

/** JSON-RPC result -> the tool Lambda's own JSON (it returns { ok, ... } as MCP text content). */
export function parseToolCallResponse(raw: string, contentType: string): Record<string, unknown> {
  let rpc: any;
  try {
    if (contentType.includes("text/event-stream")) {
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      rpc = JSON.parse(data[data.length - 1] ?? "{}");
    } else {
      rpc = JSON.parse(raw);
    }
  } catch {
    return { ok: false, code: "GATEWAY_ERROR", message: "Unreadable User Gateway response." };
  }
  if (rpc?.error) {
    return { ok: false, code: "GATEWAY_ERROR", message: String(rpc.error.message ?? "Tool call failed.").slice(0, 300) };
  }
  const text = (rpc?.result?.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { ok: !rpc.result.isError, text };
    }
  }
  return { ok: false, code: "GATEWAY_ERROR", message: "Empty tool result." };
}
