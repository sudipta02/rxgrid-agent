/**
 * Lambda entry point for the result-guard after_tool_call hook.
 * IAM (scoped in infra): bedrock:ApplyGuardrail on the tool-result guardrail only.
 */
import { guardrailChecker, requireEnv } from "../../shared/hook-deps.js";
import type { HookPayload } from "../../shared/hooks.js";
import { resultGuard, type ToolResultContext } from "./core.js";

const checkResult = guardrailChecker(requireEnv("RESULT_GUARDRAIL_ID"), requireEnv("RESULT_GUARDRAIL_VERSION"));

export const handler = async (event: HookPayload<ToolResultContext>) => {
  const decision = await resultGuard(event, checkResult);
  console.log(
    JSON.stringify({
      hook: "result-guard",
      sessionId: event?.sessionId,
      hookEventId: event?.hookEventId,
      toolName: event?.context?.toolName,
      ...decision,
    }),
  );
  return decision;
};
