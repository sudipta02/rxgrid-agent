import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../..");

export interface SanitizerStackProps extends StackProps {
  sessions: dynamodb.ITableV2;
  userPool: cognito.IUserPool;
  userClients: cognito.IUserPoolClient[];
  /** User Gateway MCP endpoint (ToolsStack). */
  userGatewayUrl: string;
  /** Harness ARN (HarnessStack): the only harness this API invokes. */
  harnessArn: string;
  /** User Gateway tool names, "<target>___<tool>". */
  createHoldTool: string;
  listHoldsTool: string;
}

/**
 * RxGrid sanitizer API (layer L2): the only way a browser reaches the harness.
 *
 *   Regional REST API -> Cognito authorizer (access tokens) -> streaming Lambda
 *     POST /sessions, POST /chat, POST /confirm  (NDJSON responses)
 *
 * REST (not HTTP API) because agent turns can outlast the HTTP API's 30 s limit; REST
 * response streaming allows up to 15 min (5 min idle on Regional endpoints).
 *
 * The Lambda calls the harness and the User Gateway with the person's own bearer token,
 * so its role needs nothing but the Sessions table. The harness ARN comes from HarnessStack.
 * Context:
 *   -c allowedOrigins=https://app.example.com,http://localhost:3000   (CORS)
 */
export class SanitizerStack extends Stack {
  readonly api: apigw.RestApi;

  constructor(scope: Construct, id: string, props: SanitizerStackProps) {
    super(scope, id, props);
    const { sessions, userPool, userClients } = props;

    const { harnessArn } = props;
    const allowedOrigins: string[] = String(this.node.tryGetContext("allowedOrigins") ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // ------------------------------------------------------------------ Lambda
    const logGroup = new logs.LogGroup(this, "SanitizerLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, "SanitizerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "RxGrid sanitizer API: own logs and the Sessions table only",
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    // No Scan, no Delete: sessions are revoked with UpdateItem and expire by TTL.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Sessions",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [sessions.tableArn],
      }),
    );

    const fn = new NodejsFunction(this, "SanitizerFn", {
      role,
      entry: path.join(repoRoot, "lambdas/sanitizer/index.ts"),
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, "package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Under the 5-minute idle limit of a Regional streaming API; a turn is capped at 4 rounds.
      timeout: Duration.minutes(4),
      logGroup,
      environment: {
        SESSIONS_TABLE: sessions.tableName,
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_IDS: userClients.map((c) => c.userPoolClientId).join(","),
        HARNESS_ARN: harnessArn,
        USER_GATEWAY_URL: props.userGatewayUrl,
        CREATE_HOLD_TOOL: props.createHoldTool,
        LIST_HOLDS_TOOL: props.listHoldsTool,
        ALLOWED_ORIGINS: allowedOrigins.join(","),
      },
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: false, target: "node22" },
    });

    // ------------------------------------------------------------------ API
    this.api = new apigw.RestApi(this, "SanitizerApi", {
      restApiName: "rxgrid-sanitizer",
      description: "RxGrid sanitizer API: the only path from the browser to the harness",
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      deployOptions: {
        stageName: "v1",
        // Cost and abuse control: every /chat call runs the model.
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ["POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: Duration.hours(1),
      },
      cloudWatchRole: false, // no account-level API Gateway logging role
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", {
      authorizerName: "rxgrid-cognito-access-token",
      cognitoUserPools: [userPool],
    });
    // With authorizationScopes set, API Gateway validates ACCESS tokens (which carry the
    // pharmacy_id/role claims), not ID tokens. Cognito user-pool sign-in grants this scope.
    const methodOptions: apigw.MethodOptions = {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizationScopes: ["aws.cognito.signin.user.admin"],
    };
    const integration = new apigw.LambdaIntegration(fn, { responseTransferMode: apigw.ResponseTransferMode.STREAM });
    for (const route of ["sessions", "chat", "confirm"]) {
      this.api.root.addResource(route).addMethod("POST", integration, methodOptions);
    }

    new CfnOutput(this, "SanitizerApiUrl", { value: this.api.url });
    new CfnOutput(this, "SanitizerHarnessArn", { value: harnessArn });
  }
}
