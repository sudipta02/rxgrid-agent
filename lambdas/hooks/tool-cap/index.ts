/**
 * Lambda entry point for the tool-cap before_tool_call hook.
 * IAM (scoped in infra): dynamodb:GetItem on Sessions and on DailyUsage. Nothing else.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { TABLES, type DailyUsageItem } from "../../shared/schema.js";
import { doc, getSession } from "../../shared/hook-deps.js";
import type { HookPayload } from "../../shared/hooks.js";
import { toolCap, type GetDailyUsage, type ToolCallContext } from "./core.js";

const getDailyUsage: GetDailyUsage = async (pharmacyId, date) => {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLES.dailyUsage,
      Key: { pharmacy_id: pharmacyId, date },
      ConsistentRead: true,
    }),
  );
  return res.Item as DailyUsageItem | undefined;
};

export const handler = async (event: HookPayload<ToolCallContext>) => {
  const decision = await toolCap(event, { getSession, getDailyUsage, now: () => new Date() });
  console.log(
    JSON.stringify({
      hook: "tool-cap",
      sessionId: event?.sessionId,
      hookEventId: event?.hookEventId,
      toolName: event?.context?.toolName,
      toolType: event?.context?.toolType,
      ...decision,
    }),
  );
  return decision;
};
