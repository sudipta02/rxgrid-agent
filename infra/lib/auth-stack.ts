import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Lambda sources live in <repo>/lambdas, outside the CDK app, so bundle from the repo root. */
const repoRoot = path.join(here, "../..");

/**
 * Cognito identity for RxGrid (enforcement layer L1).
 *
 * Trust model: `pharmacy_id` and `role` reach the agent only as signed access-token
 * claims that an admin controls. Nothing the user types, and no API the user can call
 * with their own token, can change them:
 *   - role        = membership of the `pharmacist` group (admin-only)
 *   - pharmacy_id = custom attribute that no app client may write
 * The pre-token-generation V2 trigger copies both into the access token.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly stressTestClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const preTokenLogs = new logs.LogGroup(this, "PreTokenLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Least privilege: the trigger only needs to write to its OWN log group. The default
    // AWSLambdaBasicExecutionRole allows writing to every log group (Resource "*").
    const preTokenRole = new iam.Role(this, "PreTokenRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "RxGrid pre-token trigger: write own logs only",
    });
    preTokenRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        // logGroupArn already ends in ":*", which covers every stream in this group.
        resources: [preTokenLogs.logGroupArn],
      }),
    );

    const preToken = new NodejsFunction(this, "PreTokenFn", {
      role: preTokenRole,
      entry: path.join(repoRoot, "lambdas/pre-token/index.ts"),
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, "package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      logGroup: preTokenLogs,
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: false, target: "node22" },
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "rxgrid-users",
      // Essentials is required to customise ACCESS tokens (V2 trigger). It is also the
      // default plan; it is set explicitly so nobody downgrades it to Lite by accident.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false, // admins create every user
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        // Mutable so an admin can move a user between pharmacies. Users cannot, because
        // no app client grants write access to it (see writeAttributes below).
        pharmacy_id: new cognito.StringAttribute({ minLen: 6, maxLen: 6, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      // OPTIONAL, not REQUIRED: the stress-test runner must sign in unattended.
      // Turn this to REQUIRED for real users.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: false, // hackathon stack
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preToken,
      cognito.LambdaVersion.V2_0,
    );

    new cognito.CfnUserPoolGroup(this, "PharmacistGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "pharmacist",
      description: "Licensed pharmacists: may transfer Schedule H1/X stock",
    });
    new cognito.CfnUserPoolGroup(this, "StaffGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "staff",
      description: "Pharmacy staff: no H1/X transfers",
    });

    // CDK makes EVERY attribute writable when writeAttributes is omitted, which would
    // let a user change their own custom:pharmacy_id. So list the writable attributes
    // explicitly: none of them is a custom attribute.
    const readAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, emailVerified: true })
      .withCustomAttributes("pharmacy_id");
    const writeAttributes = new cognito.ClientAttributes().withStandardAttributes({ email: true });

    const common: Omit<cognito.UserPoolClientOptions, "authFlows" | "userPoolClientName"> = {
      generateSecret: false, // public clients (browser and CLI runner)
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.hours(12),
      readAttributes,
      writeAttributes,
    };

    // Web UI: SRP only, so the password never leaves the browser.
    this.webClient = this.userPool.addClient("WebClient", {
      ...common,
      userPoolClientName: "rxgrid-web",
      authFlows: { userSrp: true },
    });

    // Stress-test runner: plain password auth over TLS, for simplicity. A separate client
    // so it can be removed after the hackathon without touching the web app.
    this.stressTestClient = this.userPool.addClient("StressTestClient", {
      ...common,
      userPoolClientName: "rxgrid-stress-test",
      authFlows: { userPassword: true },
    });

    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "Issuer", { value: issuer });
    // Harness `customJWTAuthorizer.discoveryUrl` and the Gateway JWT authorizer use this.
    new CfnOutput(this, "DiscoveryUrl", { value: `${issuer}/.well-known/openid-configuration` });
    new CfnOutput(this, "WebClientId", { value: this.webClient.userPoolClientId });
    new CfnOutput(this, "StressTestClientId", { value: this.stressTestClient.userPoolClientId });
  }
}
