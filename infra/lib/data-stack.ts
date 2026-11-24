import { Stack, StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import {
  TABLES,
  INDEXES,
  SEARCH_PROJECTION,
  SENSITIVE_INVENTORY_ATTRS,
} from "../../lambdas/shared/schema.js";

/**
 * DynamoDB tables for RxGrid. Every table uses on-demand billing, so an idle hackathon
 * stack costs almost nothing. IAM grants are not made here: each Lambda stack grants
 * itself only the actions it needs on the exact table or index ARN (layer 5).
 */
export class DataStack extends Stack {
  readonly pharmacies: dynamodb.TableV2;
  readonly inventory: dynamodb.TableV2;
  readonly holds: dynamodb.TableV2;
  readonly dailyUsage: dynamodb.TableV2;
  readonly sessions: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Fail synth if someone adds a sensitive attribute to the search projection.
    const leaked = SEARCH_PROJECTION.filter((a) =>
      (SENSITIVE_INVENTORY_ATTRS as readonly string[]).includes(a),
    );
    if (leaked.length) {
      throw new Error(`Sensitive attrs in search projection: ${leaked.join(", ")}`);
    }

    const common = {
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY, // hackathon stack; switch to RETAIN for real data
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    };

    this.pharmacies = new dynamodb.TableV2(this, "Pharmacies", {
      ...common,
      tableName: TABLES.pharmacies,
      partitionKey: { name: "pharmacy_id", type: dynamodb.AttributeType.STRING },
    });

    this.inventory = new dynamodb.TableV2(this, "Inventory", {
      ...common,
      tableName: TABLES.inventory,
      partitionKey: { name: "pharmacy_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: INDEXES.inventoryBySalt,
          partitionKey: { name: "salt_strength", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "expiry_pharmacy", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.INCLUDE,
          nonKeyAttributes: [...SEARCH_PROJECTION],
        },
        {
          indexName: INDEXES.inventoryByBrand,
          partitionKey: { name: "brand_norm", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "expiry_pharmacy", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.INCLUDE,
          nonKeyAttributes: [...SEARCH_PROJECTION],
        },
      ],
    });

    this.holds = new dynamodb.TableV2(this, "Holds", {
      ...common,
      tableName: TABLES.holds,
      partitionKey: { name: "requesting_pharmacy_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "hold_id", type: dynamodb.AttributeType.STRING },
    });

    this.dailyUsage = new dynamodb.TableV2(this, "DailyUsage", {
      ...common,
      tableName: TABLES.dailyUsage,
      partitionKey: { name: "pharmacy_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    this.sessions = new dynamodb.TableV2(this, "Sessions", {
      ...common,
      tableName: TABLES.sessions,
      partitionKey: { name: "session_id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    for (const [k, t] of Object.entries({
      Pharmacies: this.pharmacies,
      Inventory: this.inventory,
      Holds: this.holds,
      DailyUsage: this.dailyUsage,
      Sessions: this.sessions,
    })) {
      new CfnOutput(this, `${k}TableName`, { value: t.tableName });
    }
  }
}
