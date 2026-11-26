/**
 * Lambda entry point for create_hold (User Gateway target).
 *
 * IAM (scoped in infra): dynamodb:GetItem on Inventory (base table, for the true price and
 * schedule), dynamodb:PutItem on Holds, dynamodb:UpdateItem on DailyUsage. The Put and the
 * Update run in ONE transaction, so the daily cap cannot be raced by parallel requests.
 */
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { LIMITS, TABLES, type InventoryItem } from "../shared/schema.js";
import { ToolError, fail, propagatedHeaders, toolName, type GatewayContext } from "../shared/gateway.js";
import { resolveCaller } from "../shared/caller.js";
import { DailyCapExceeded, createHold, type CreateHoldInput, type HoldDeps } from "./core.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export const deps: HoldDeps = {
  now: () => new Date(),
  async getInventory(pharmacyId, sk) {
    const res = await doc.send(new GetCommand({ TableName: TABLES.inventory, Key: { pharmacy_id: pharmacyId, sk } }));
    return res.Item as InventoryItem | undefined;
  },
  async commitHold(hold, usage) {
    const ttl = Math.floor(Date.now() / 1000) + 35 * 86_400;
    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.holds,
                Item: hold,
                ConditionExpression: "attribute_not_exists(hold_id)",
              },
            },
            {
              Update: {
                TableName: TABLES.dailyUsage,
                Key: { pharmacy_id: usage.pharmacy_id, date: usage.date },
                UpdateExpression:
                  "SET units_total = if_not_exists(units_total, :zero) + :u, inr_total = if_not_exists(inr_total, :zero) + :i, hold_count = if_not_exists(hold_count, :zero) + :one, #ttl = :ttl",
                // First hold of the day always fits (per-request limits are below the daily caps).
                ConditionExpression:
                  "attribute_not_exists(units_total) OR (units_total <= :uMax AND inr_total <= :iMax AND hold_count <= :cMax)",
                ExpressionAttributeNames: { "#ttl": "ttl" },
                ExpressionAttributeValues: {
                  ":zero": 0,
                  ":one": 1,
                  ":u": usage.units,
                  ":i": usage.inr,
                  ":ttl": ttl,
                  ":uMax": LIMITS.dailyUnitCap - usage.units,
                  ":iMax": LIMITS.dailyInrCap - usage.inr,
                  ":cMax": LIMITS.dailyHoldCountCap - 1,
                },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (e instanceof TransactionCanceledException && e.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed") {
        throw new DailyCapExceeded();
      }
      throw e;
    }
  },
};

export const handler = async (event: CreateHoldInput, context: GatewayContext) => {
  const name = toolName(context);
  if (name && name !== "create_hold") return fail("UNKNOWN_TOOL", `This target does not serve ${name}.`);
  try {
    const caller = await resolveCaller(propagatedHeaders(context));
    const out = await createHold(event, caller, deps);
    console.log(JSON.stringify({ tool: "create_hold", decision: "PLACED", hold_id: out.hold_id, pharmacy_id: caller.pharmacy_id }));
    return out;
  } catch (e) {
    if (e instanceof ToolError) {
      console.log(JSON.stringify({ tool: "create_hold", decision: "REFUSED", code: e.code }));
      return fail(e.code, e.message, e.extra);
    }
    console.error(e);
    return fail("INTERNAL", "The hold could not be placed. Nothing was saved.");
  }
};
