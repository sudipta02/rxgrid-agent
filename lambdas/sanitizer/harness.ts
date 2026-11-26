/**
 * InvokeHarness over HTTPS with the signed-in person's bearer token.
 *
 * The harness uses Cognito JWT inbound auth, and a JWT harness rejects SigV4 (the only auth
 * scheme the JS SDK client supports), so this calls the documented endpoint directly:
 *   POST https://bedrock-agentcore.<region>.amazonaws.com/harnesses/invoke?harnessArn=<arn>
 *   Authorization: Bearer <access token>
 *   X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <33-256 chars>
 * The response is an AWS binary event stream (the same framing as Bedrock ConverseStream).
 * See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html
 *
 * The body is built ONLY from `messages` (constructed by the sanitizer) and the pinned
 * ALLOWED_TOOLS. No other override (tools, skills, model, systemPrompt, actorId, ...) is
 * ever sent; the harness defaults apply.
 */
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { ALLOWED_TOOLS } from "../shared/tools.js";

export interface HarnessEvent {
  /** Event type from the `:event-type` header, e.g. contentBlockDelta, messageStop, hookEvent. */
  type: string;
  body: Record<string, any>;
}

export type HarnessContentBlock =
  | { text: string }
  | { toolResult: { toolUseId: string; status: "success" | "error"; content: { text: string }[] } };

export interface HarnessMessage {
  role: "user";
  content: HarnessContentBlock[];
}

export type InvokeHarness = (token: string, sessionId: string, messages: HarnessMessage[]) => AsyncIterable<HarnessEvent>;

export class HarnessError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    // Detail is the service's error text (never a token); it lands in CloudWatch, not in the UI.
    super(`InvokeHarness failed (${status}): ${detail}`);
  }
}

/** The exact request body. Exported so tests can pin what is (and is not) sent. */
export function harnessRequestBody(messages: HarnessMessage[]) {
  return { messages, allowedTools: [...ALLOWED_TOOLS] };
}

export function harnessInvoker(region: string, harnessArn: string): InvokeHarness {
  const url = `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke?harnessArn=${encodeURIComponent(harnessArn)}`;
  return async function* invoke(token, sessionId, messages) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.amazon.eventstream",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      },
      body: JSON.stringify(harnessRequestBody(messages)),
    });
    if (res.status !== 200 || !res.body) {
      throw new HarnessError(res.status, (await res.text().catch(() => "")).slice(0, 500));
    }
    yield* decodeEventStream(res.body as AsyncIterable<Uint8Array>);
  };
}

/**
 * Decode AWS event-stream frames from arbitrary byte chunks. Exception frames throw.
 *
 * EventStreamCodec.decode() needs exactly one whole frame, but HTTP chunks split frames at
 * any byte. Each frame starts with its total length (4-byte big-endian), so buffer until a
 * whole frame is available, then decode it (the codec also checks both CRCs).
 */
export async function* decodeEventStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<HarnessEvent> {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  let buf = new Uint8Array(0);
  for await (const chunk of chunks) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= 4) {
      const total = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (total < 16 || total > 16 * 1024 * 1024) throw new HarnessError(502, `Bad event-stream frame length ${total}`);
      if (buf.length < total) break;
      const msg = codec.decode(buf.subarray(0, total));
      buf = buf.slice(total);

      const h = (k: string) => msg.headers[k]?.value as string | undefined;
      const text = toUtf8(msg.body);
      const body = text ? (JSON.parse(text) as Record<string, any>) : {};
      const kind = h(":message-type");
      if (kind === "exception" || kind === "error") {
        throw new HarnessError(500, `${h(":exception-type") ?? h(":error-code") ?? "error"}: ${String(body.message ?? text).slice(0, 300)}`);
      }
      yield { type: h(":event-type") ?? "unknown", body };
    }
  }
  if (buf.length) throw new HarnessError(502, "Event stream ended mid-frame.");
}
