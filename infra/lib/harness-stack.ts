import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { ALLOWED_TOOLS, HARNESS_GATEWAY_TOOL, INLINE_TOOLS } from "../../lambdas/shared/tools.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { INLINE_CREATE_HOLD, INLINE_LIST_HOLDS } from "./tool-schemas.js";

/** Harness name: letters, digits and underscores, at most 40 characters (CreateHarness). */
export const HARNESS_NAME = "rxgrid_agent";

/**
 * Literal execution-role name. ToolsStack builds the Cedar principal id from it
 * (arn:aws:sts::<acct>:assumed-role/<name>) without a cross-stack reference, which would
 * otherwise be a cycle (the harness needs the gateway ARN, the gateway policy needs the role).
 */
export const HARNESS_ROLE_NAME = "rxgrid-harness-execution";

/**
 * Claude on Bedrock. In ap-southeast-2 every Claude model is INFERENCE_PROFILE-only (no
 * in-Region on-demand). The AU geographic profile is the narrowest: it routes only to
 * ap-southeast-2 and ap-southeast-4, so prompts stay in Australia. The project SCP
 * (RegionFloor) exempts bedrock:InvokeModel* from its Region restriction, so the
 * ap-southeast-4 leg is allowed. Destination Regions come from GetInferenceProfile.
 */
export const MODEL = {
  inferenceProfileId: "au.anthropic.claude-sonnet-5-5",
  foundationModelId: "anthropic.claude-sonnet-5-5",
  destinationRegions: ["ap-southeast-2", "ap-southeast-4"],
} as const;

export interface HarnessStackProps extends StackProps {
  userPool: cognito.IUserPool;
  /** App clients whose access tokens may invoke the harness (same as the sanitizer accepts). */
  userClients: cognito.IUserPoolClient[];
  /** Agent Gateway (ToolsStack): the only gateway on the model path. */
  agentGatewayArn: string;
  /** HooksStack.harnessHooks and the Lambda ARNs behind them. */
  hooks: agentcore.CfnHarness.HarnessHookProperty[];
  hookFunctionArns: string[];
}

/**
 * RxGrid harness (AWS::BedrockAgentCore::Harness). Layers it carries:
 *   L1  CUSTOM_JWT inbound auth: Cognito access tokens from the two app clients only.
 *   L3  allowedTools = ALLOWED_TOOLS (never "*", never omitted). The sanitizer also pins it
 *       per call, so both the default and every invocation are narrowed.
 *   L6  the three hooks, failureMode deny.
 * No memory (explicitly disabled), no browser, code interpreter, remote MCP or skills.
 */
export class HarnessStack extends Stack {
  readonly harness: agentcore.CfnHarness;
  readonly harnessArn: string;
  readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: HarnessStackProps) {
    super(scope, id, props);
    const { userPool, userClients, agentGatewayArn, hooks, hookFunctionArns } = props;

    // --------------------------------------------------------------- execution role
    const role = new iam.Role(this, "ExecutionRole", {
      roleName: HARNESS_ROLE_NAME,
      description: "RxGrid harness: one model profile, the Agent Gateway, three hook Lambdas, own logs",
      // Confused-deputy protection: only AgentCore acting for THIS account. The exact
      // SourceArn the service presents (harness or underlying runtime ARN) is not
      // documented, so it is pinned to this account's bedrock-agentcore ARNs.
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });
    this.executionRole = role;

    const profileArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${MODEL.inferenceProfileId}`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeModelProfile",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [profileArn],
      }),
    );
    // Geographic cross-Region inference also authorises the foundation model in every
    // destination Region, but only when routed through this profile.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeModelViaProfileOnly",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: MODEL.destinationRegions.map(
          (r) => `arn:${this.partition}:bedrock:${r}::foundation-model/${MODEL.foundationModelId}`,
        ),
        conditions: { StringEquals: { "bedrock:InferenceProfileArn": profileArn } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeAgentGatewayOnly",
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [agentGatewayArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeHookLambdasOnly",
        actions: ["lambda:InvokeFunction"],
        resources: hookFunctionArns,
      }),
    );

    // Own logs. The runtime's log group name (/aws/bedrock-agentcore/runtimes/<runtimeId>-*)
    // is only known after create, so this follows the AWS sample: runtimes/* in this account
    // and Region. Narrow it to the runtime ID after deploy.
    const runtimeLogs = `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "OwnLogGroups",
        actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        resources: [runtimeLogs],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "OwnLogStreams",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${runtimeLogs}:log-stream:*`],
      }),
    );
    // DescribeLogGroups is a list action: it authorises against log-group:* (sample policy).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DescribeLogGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`],
      }),
    );

    // REQUIRED "*" (AWS sample policy): the harness pulls its managed container image from
    // Amazon ECR Public. Neither action supports resource-level permissions.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrPublicTokenRequiredStar",
        actions: ["ecr-public:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrPublicBearerTokenRequiredStar",
        actions: ["sts:GetServiceBearerToken"],
        resources: ["*"],
        conditions: { StringEquals: { "sts:AWSServiceName": "ecr-public.amazonaws.com" } },
      }),
    );

    // Workload identity for this harness only (sample policy). With JWT inbound auth the
    // runtime exchanges the caller's JWT for a workload access token.
    const wid = `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "OwnWorkloadIdentity",
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
        resources: [wid, `${wid}/workload-identity/harness_${HARNESS_NAME}-*`],
      }),
    );

    // Belt and braces: even if a broad policy were attached later, the role cannot switch
    // to another role (an additionalParams risk in harness-security) or run commands.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyRoleSwitchAndDirectCommands",
        effect: iam.Effect.DENY,
        actions: [
          "sts:AssumeRole",
          "bedrock-agentcore:InvokeAgentRuntimeCommand",
          "bedrock-agentcore:InvokeAgentRuntimeCommandShell",
        ],
        resources: ["*"],
      }),
    );

    // ---------------------------------------------------------------------- harness
    this.harness = new agentcore.CfnHarness(this, "Harness", {
      harnessName: HARNESS_NAME,
      executionRoleArn: role.roleArn,
      model: {
        bedrockModelConfig: {
          modelId: MODEL.inferenceProfileId,
          apiFormat: "converse_stream", // native Converse: no bedrock-mantle permissions needed
          maxTokens: 2048,
        },
      },
      systemPrompt: [{ text: SYSTEM_PROMPT }],
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
          // Cognito access tokens carry client_id (not aud); allowedClients checks it.
          allowedClients: userClients.map((c) => c.userPoolClientId),
        },
      },
      tools: [
        {
          type: "agentcore_gateway",
          name: HARNESS_GATEWAY_TOOL,
          config: { agentCoreGateway: { gatewayArn: agentGatewayArn, outboundAuth: { awsIam: {} } } },
        },
        { type: "inline_function", name: INLINE_TOOLS.createHold, config: { inlineFunction: INLINE_CREATE_HOLD } },
        { type: "inline_function", name: INLINE_TOOLS.listHolds, config: { inlineFunction: INLINE_LIST_HOLDS } },
      ],
      allowedTools: [...ALLOWED_TOOLS],
      hooks,
      // Explicit opt-out: managed memory would keep conversation data (and any poisoned
      // tool result) beyond the session and need extra Memory permissions.
      memory: { disabled: {} },
      // Fixed limits (the managed defaults can change). A turn is search, then at most a
      // couple of tool calls; the sanitizer caps a /chat request at 4 rounds.
      maxIterations: 8,
      maxTokens: 8192,
      timeoutSeconds: 120,
      truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 40 } } },
    });
    this.harness.node.addDependency(role); // policies must exist before the harness validates the role
    this.harnessArn = this.harness.attrArn;

    new CfnOutput(this, "HarnessArn", { value: this.harnessArn });
    new CfnOutput(this, "HarnessId", { value: this.harness.attrHarnessId });
    new CfnOutput(this, "HarnessExecutionRoleArn", { value: role.roleArn });
    new CfnOutput(this, "HarnessModel", { value: MODEL.inferenceProfileId });
  }
}
