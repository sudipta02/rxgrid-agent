/**
 * Lambda entry point for search_inventory (Agent Gateway target).
 * IAM: dynamodb:Query on the two Inventory index ARNs only (no base table, no Scan).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLES, INDEXES, MAX_SEARCH_RESULTS } from "../shared/schema.js";
import { ToolError, fail, toolName, type GatewayContext } from "../shared/gateway.js";
import { searchInventory, type IndexRow, type QueryIndex, type SearchInput } from "./core.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const query: QueryIndex = async (index, pk, skFrom) => {
  const pkName = index === INDEXES.inventoryBySalt ? "salt_norm" : "brand_family";
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLES.inventory,
      IndexName: index,
      KeyConditionExpression: "#pk = :pk AND #sk >= :from",
      ExpressionAttributeNames: { "#pk": pkName, "#sk": "expiry_pharmacy" },
      ExpressionAttributeValues: { ":pk": pk, ":from": skFrom },
      // Read a little more than we return, so `truncated` can be reported honestly.
      Limit: MAX_SEARCH_RESULTS * 3,
    }),
  );
  return (res.Items ?? []) as IndexRow[];
};

export const handler = async (event: SearchInput, context: GatewayContext) => {
  const name = toolName(context);
  if (name && name !== "search_inventory") return fail("UNKNOWN_TOOL", `This target does not serve ${name}.`);
  try {
    return await searchInventory(event, query);
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message, e.extra);
    console.error(e);
    return fail("INTERNAL", "Search failed. Try again or ask a pharmacist.");
  }
};
