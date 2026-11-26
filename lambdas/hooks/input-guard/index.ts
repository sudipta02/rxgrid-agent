/**
 * Lambda entry point for the input-guard before_invocation hook.
 * IAM (scoped in infra): dynamodb:GetItem on Sessions, bedrock:ApplyGuardrail on the input guardrail.
 * Any thrown error makes the harness apply failureMode, which must be "deny".
 */
import { getSession, guardrailChecker, requireEnv } from "../../shared/hook-deps.js";
import { inputGuard, type InputContext } from "./core.js";
import type { HookPayload } from "../../shared/hooks.js";

const checkInput = guardrailChecker(requireEnv("INPUT_GUARDRAIL_ID"), requireEnv("INPUT_GUARDRAIL_VERSION"));

export const handler = async (event: HookPayload<InputContext>) => {
  const decision = await inputGuard(event, { getSession, checkInput });
  console.log(JSON.stringify({ hook: "input-guard", sessionId: event?.sessionId, hookEventId: event?.hookEventId, ...decision }));
  return decision;
};
