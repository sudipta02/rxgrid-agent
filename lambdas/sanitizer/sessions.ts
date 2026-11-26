/**
 * Sessions table access for the sanitizer. IAM (scoped in infra): GetItem, PutItem and
 * UpdateItem on the Sessions table only. Each condition below is a security property:
 *   create        never overwrites an existing session (no fixation)
 *   setPending    at most one pending hold, never on a revoked session
 *   claimPending  removes the pending hold only if the tool_use_id matches: runs once
 *   revoke        permanent; also drops any pending hold
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { TABLES, type PendingHold, type SessionItem } from "../shared/schema.js";
import type { SessionStore } from "./core.js";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const T = () => TABLES.sessions;

export const dynamoSessions: SessionStore = {
  async create(item: SessionItem) {
    await doc.send(new PutCommand({ TableName: T(), Item: item, ConditionExpression: "attribute_not_exists(session_id)" }));
  },
  async get(sessionId) {
    const res = await doc.send(new GetCommand({ TableName: T(), Key: { session_id: sessionId }, ConsistentRead: true }));
    return res.Item as SessionItem | undefined;
  },
  async setPending(sessionId, pending: PendingHold) {
    await doc.send(
      new UpdateCommand({
        TableName: T(),
        Key: { session_id: sessionId },
        UpdateExpression: "SET pending = :p",
        ConditionExpression: "attribute_exists(session_id) AND attribute_not_exists(pending) AND attribute_not_exists(revoked)",
        ExpressionAttributeValues: { ":p": pending },
      }),
    );
  },
  async claimPending(sessionId, toolUseId) {
    try {
      const res = await doc.send(
        new UpdateCommand({
          TableName: T(),
          Key: { session_id: sessionId },
          UpdateExpression: "REMOVE pending",
          ConditionExpression: "pending.tool_use_id = :id AND attribute_not_exists(revoked)",
          ExpressionAttributeValues: { ":id": toolUseId },
          ReturnValues: "ALL_OLD",
        }),
      );
      return (res.Attributes as SessionItem | undefined)?.pending;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return undefined;
      throw e;
    }
  },
  async revoke(sessionId) {
    await doc.send(
      new UpdateCommand({
        TableName: T(),
        Key: { session_id: sessionId },
        UpdateExpression: "SET revoked = :t REMOVE pending",
        ConditionExpression: "attribute_exists(session_id)",
        ExpressionAttributeValues: { ":t": true },
      }),
    );
  },
};
