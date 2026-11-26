/**
 * AWS-backed implementations of the hook dependencies (Sessions lookup, ApplyGuardrail).
 * Kept apart from hooks.ts so the pure hook logic and its tests never load the SDK.
 */
import { BedrockRuntimeClient, ApplyGuardrailCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { PHARMACY_ID_PATTERN, TABLES, type SessionItem } from "./schema.js";
import type { CheckText, GetSession, GuardrailVerdict } from "./hooks.js";

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

/** Fails closed: a malformed or expired row is treated as no session. */
export const getSession: GetSession = async (sessionId) => {
  if (!sessionId) return undefined;
  const res = await doc.send(new GetCommand({ TableName: TABLES.sessions, Key: { session_id: sessionId } }));
  const item = res.Item as SessionItem | undefined;
  if (!item || item.revoked) return undefined;
  if (typeof item.ttl === "number" && item.ttl * 1000 < Date.now()) return undefined;
  if (!PHARMACY_ID_PATTERN.test(String(item.pharmacy_id))) return undefined;
  if (item.role !== "staff" && item.role !== "pharmacist") return undefined;
  return { pharmacy_id: item.pharmacy_id, role: item.role, sub: String(item.sub) };
};

/**
 * ApplyGuardrail with source INPUT. Prompt-attack detection only runs on INPUT, so tool
 * results (untrusted content headed for the model) are checked as INPUT too.
 * Errors propagate: the hook Lambda fails and the harness applies failureMode "deny".
 */
export function guardrailChecker(guardrailId: string, guardrailVersion: string): CheckText {
  return async (texts) => {
    if (texts.length === 0) return { intervened: false, findings: [] };
    const res = await bedrock.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: guardrailId,
        guardrailVersion,
        source: "INPUT",
        content: texts.map((text) => ({ text: { text } })),
      }),
    );
    return summarise(res.action, res.assessments);
  };
}

function summarise(action: string | undefined, assessments: unknown[] | undefined): GuardrailVerdict {
  const findings = new Set<string>();
  for (const a of (assessments ?? []) as Record<string, any>[]) {
    for (const t of a.topicPolicy?.topics ?? []) if (t.action === "BLOCKED") findings.add(`topic:${t.name}`);
    for (const f of a.contentPolicy?.filters ?? []) if (f.action === "BLOCKED") findings.add(`content:${f.type}`);
    for (const w of a.wordPolicy?.customWords ?? []) if (w.action === "BLOCKED") findings.add("word:custom");
    for (const w of a.wordPolicy?.managedWordLists ?? []) if (w.action === "BLOCKED") findings.add(`word:${w.type}`);
  }
  return { intervened: action === "GUARDRAIL_INTERVENED", findings: [...findings] };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}
