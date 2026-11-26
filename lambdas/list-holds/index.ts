/**
 * list_holds: the signed-in user's own pharmacy's holds (User Gateway only, rule C2).
 *
 * IAM (scoped in infra): dynamodb:Query on the Holds table. The partition key is always the
 * pharmacy from the VERIFIED token; an input naming another pharmacy is refused.
 * Prices are left out of the output: they are the source pharmacy's commercial data (R3).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TABLES, type HoldItem } from "../shared/schema.js";
import { ToolError, fail, propagatedHeaders, toolName, type GatewayContext } from "../shared/gateway.js";
import { assertOwnPharmacy, resolveCaller, type Caller } from "../shared/caller.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAX_HOLDS = 50;

export type QueryHolds = (pharmacyId: string) => Promise<HoldItem[]>;

export async function listHolds(input: { pharmacy_id?: string }, caller: Caller, queryHolds: QueryHolds) {
  assertOwnPharmacy(caller, input?.pharmacy_id);
  const holds = await queryHolds(caller.pharmacy_id);
  return {
    ok: true as const,
    pharmacy_id: caller.pharmacy_id,
    holds: holds.slice(0, MAX_HOLDS).map((h) => ({
      hold_id: h.hold_id,
      status: h.status,
      source_pharmacy_id: h.source_pharmacy_id,
      brand_name: h.brand_name,
      salt: h.salt,
      strength: h.strength,
      schedule: h.schedule,
      qty: h.qty,
      is_substitute: h.is_substitute,
      created_at: h.created_at,
    })),
  };
}

const queryHolds: QueryHolds = async (pharmacyId) => {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLES.holds,
      KeyConditionExpression: "requesting_pharmacy_id = :p",
      ExpressionAttributeValues: { ":p": pharmacyId },
      ScanIndexForward: false,
      Limit: MAX_HOLDS,
    }),
  );
  return (res.Items ?? []) as HoldItem[];
};

export const handler = async (event: { pharmacy_id?: string }, context: GatewayContext) => {
  const name = toolName(context);
  if (name && name !== "list_holds") return fail("UNKNOWN_TOOL", `This target does not serve ${name}.`);
  try {
    const caller = await resolveCaller(propagatedHeaders(context));
    return await listHolds(event, caller, queryHolds);
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message, e.extra);
    console.error(e);
    return fail("INTERNAL", "Could not list holds.");
  }
};
