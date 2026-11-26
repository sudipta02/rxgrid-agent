/**
 * Lambda entry point for the sanitizer API (API Gateway REST, Lambda proxy, response
 * streaming). Routes: POST /sessions, POST /chat, POST /confirm.
 *
 * Responses are NDJSON (one UiEvent per line). The response is opened lazily: an ApiError
 * thrown before the first event gets its real status code; after that, failures are sent
 * as an `error` event. Logs carry decisions and sizes, never tokens or message text.
 *
 * IAM (scoped in infra): GetItem/PutItem/UpdateItem on Sessions. Nothing for the harness or
 * the User Gateway: both are called with the person's own bearer token.
 */
import { resolveCaller, USER_TOKEN_HEADER } from "../shared/caller.js";
import { ToolError } from "../shared/gateway.js";
import { ApiError, chat, confirm, createSession, type SanitizerDeps, type UiEvent } from "./core.js";
import { harnessInvoker } from "./harness.js";
import { dynamoSessions } from "./sessions.js";
import { userGatewayCaller } from "./user-gateway.js";

interface ResponseStream {
  write(chunk: string): void;
  end(): void;
}
declare const awslambda: {
  streamifyResponse(handler: (event: ProxyEvent, stream: ResponseStream) => Promise<void>): unknown;
  HttpResponseStream: { from(stream: ResponseStream, meta: { statusCode: number; headers: Record<string, string> }): ResponseStream };
};

interface ProxyEvent {
  resource?: string;
  httpMethod?: string;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

const MAX_BODY_BYTES = 8 * 1024;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

const deps: SanitizerDeps = {
  async verify(authorization) {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!m) throw new ApiError(401, "UNAUTHENTICATED", "Sign in first.");
    try {
      const caller = await resolveCaller({ [USER_TOKEN_HEADER]: m[1]! });
      return { caller, token: m[1]! };
    } catch (e) {
      if (e instanceof ToolError) throw new ApiError(401, "UNAUTHENTICATED", e.message);
      throw e;
    }
  },
  sessions: dynamoSessions,
  invoke: harnessInvoker(env("AWS_REGION"), env("HARNESS_ARN")),
  callUserTool: userGatewayCaller(env("USER_GATEWAY_URL")),
  userTools: { createHold: env("CREATE_HOLD_TOOL"), listHolds: env("LIST_HOLDS_TOOL") },
  now: () => new Date(),
};

const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean));

function header(event: ProxyEvent, name: string): string | undefined {
  const h = event.headers ?? {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? (h[key] ?? undefined) : undefined;
}

export const handler = awslambda.streamifyResponse(async (event, raw) => {
  const origin = header(event, "origin");
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  let out: ResponseStream | undefined;
  const open = (statusCode: number) => (out ??= awslambda.HttpResponseStream.from(raw, { statusCode, headers }));
  const emit = (e: UiEvent) => open(200).write(`${JSON.stringify(e)}\n`);
  const route = `${event.httpMethod} ${event.resource}`;
  const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ route, ...fields }));

  try {
    const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? null);
    if (body && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ApiError(413, "TOO_LARGE", "Request too large.");
    const auth = header(event, "authorization");

    switch (route) {
      case "POST /sessions": {
        const r = await createSession(deps, auth);
        emit({ type: "session", sessionId: r.sessionId });
        log({ decision: "SESSION_CREATED" });
        break;
      }
      case "POST /chat":
        await chat(deps, auth, body, emit);
        log({ decision: "OK", bodyBytes: body?.length ?? 0 });
        break;
      case "POST /confirm":
        await confirm(deps, auth, body, emit);
        log({ decision: "OK" });
        break;
      default:
        throw new ApiError(404, "NOT_FOUND", "No such route.");
    }
  } catch (e) {
    const err =
      e instanceof ApiError ? e : new ApiError(500, "INTERNAL", "Something went wrong. Nothing was changed; try again.");
    if (!(e instanceof ApiError)) console.error(e);
    log({ decision: "REFUSED", status: err.status, code: err.code, message: err.message });
    open(err.status).write(`${JSON.stringify({ type: "error", code: err.code, message: err.message } satisfies UiEvent)}\n`);
  } finally {
    open(200).end();
  }
});
