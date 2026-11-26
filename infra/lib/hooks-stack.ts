import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../..");

/** Harness hook timeout. The Lambda timeout is shorter, so a slow call fails (-> deny) inside it. */
export const HOOK_TIMEOUT_SECONDS = 10;

export interface HooksStackProps extends StackProps {
  sessions: dynamodb.ITableV2;
  dailyUsage: dynamodb.ITableV2;
}

/**
 * RxGrid harness lifecycle hooks (layers L6/L7) and the Bedrock Guardrails they call.
 *
 *   input-guard   before_invocation  Sessions check + INPUT guardrail on user text
 *   tool-cap      before_tool_call   tool allowlist + early create_hold limits
 *   result-guard  after_tool_call    tool-result guardrail (prompt attack) on tool output
 *
 * The harness execution role invokes these synchronously. Same account, so the harness
 * role needs only an identity policy (lambda:InvokeFunction on the three ARNs output here);
 * no Lambda resource policy is added. Configure every hook with failureMode "deny".
 *
 * Guardrails use the CLASSIC tier on purpose: the STANDARD tier requires cross-Region
 * inference, and this project's SCP denies every Region except ap-southeast-2.
 */
export class HooksStack extends Stack {
  constructor(scope: Construct, id: string, props: HooksStackProps) {
    super(scope, id, props);
    const { sessions, dailyUsage } = props;

    // ------------------------------------------------------------------ Guardrails
    const input = this.guardrail("InputGuardrail", {
      name: "rxgrid-input",
      description: "RxGrid user input: no dosing/medical advice, prompt attacks, harmful content",
      blockedInputMessaging:
        "Sorry, I can't help with that. I can find medicine stock in partner pharmacies and place hold requests.",
      blockedOutputsMessaging: "Sorry, I can't share that. Please ask a pharmacist.",
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: "CLASSIC" },
        filtersConfig: [
          // PROMPT_ATTACK applies to input only; its output strength must be NONE.
          { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
          { type: "HATE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "INSULTS", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "SEXUAL", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          { type: "VIOLENCE", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          // LOW: higher strengths risk flagging normal requests for controlled (Schedule X) stock.
          { type: "MISCONDUCT", inputStrength: "LOW", outputStrength: "LOW" },
        ],
      },
      topicPolicyConfig: {
        topicsTierConfig: { tierName: "CLASSIC" },
        topicsConfig: [
          {
            name: "DosingAdvice",
            type: "DENY",
            // Rule R1. Stock questions about a drug must still pass, so the definition is about advice.
            definition:
              "Advice on medicine doses, frequency, indications, interactions, side effects, or whether a person should take, stop or switch a medicine.",
            examples: [
              "How many tablets of Dolo 650 can I give my father in a day?",
              "Is it safe to take Alprax with alcohol?",
              "What dose of metformin should a diabetic start on?",
              "Can a pregnant woman take this antibiotic?",
              "Which painkiller is best for a migraine?",
            ],
          },
        ],
      },
    });

    // Prompt attack only: stock rows mention drugs and strengths, which the dosing topic and
    // content filters have no business judging. Tool output is checked as INPUT (the only
    // source on which prompt-attack detection runs).
    const toolResult = this.guardrail("ToolResultGuardrail", {
      name: "rxgrid-tool-result",
      description: "RxGrid tool results: indirect prompt injection (e.g. pharmacy notes)",
      blockedInputMessaging: "A tool result was blocked as a possible prompt injection.",
      blockedOutputsMessaging: "A tool result was blocked as a possible prompt injection.",
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: "CLASSIC" },
        filtersConfig: [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }],
      },
    });

    // -------------------------------------------------------------------- Lambdas
    const inputGuard = this.hookFunction("InputGuard", "input-guard", {
      SESSIONS_TABLE: sessions.tableName,
      INPUT_GUARDRAIL_ID: input.id,
      INPUT_GUARDRAIL_VERSION: input.version,
    });
    inputGuard.role.addToPolicy(
      new iam.PolicyStatement({ sid: "ReadSession", actions: ["dynamodb:GetItem"], resources: [sessions.tableArn] }),
    );
    inputGuard.role.addToPolicy(
      new iam.PolicyStatement({ sid: "ApplyInputGuardrail", actions: ["bedrock:ApplyGuardrail"], resources: [input.arn] }),
    );

    const toolCap = this.hookFunction("ToolCap", "tool-cap", {
      SESSIONS_TABLE: sessions.tableName,
      DAILY_USAGE_TABLE: dailyUsage.tableName,
    });
    toolCap.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSessionAndUsage",
        actions: ["dynamodb:GetItem"],
        resources: [sessions.tableArn, dailyUsage.tableArn],
      }),
    );

    const resultGuard = this.hookFunction("ResultGuard", "result-guard", {
      RESULT_GUARDRAIL_ID: toolResult.id,
      RESULT_GUARDRAIL_VERSION: toolResult.version,
    });
    resultGuard.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ApplyToolResultGuardrail",
        actions: ["bedrock:ApplyGuardrail"],
        resources: [toolResult.arn],
      }),
    );

    // -------------------------------------------------------------------- Outputs
    new CfnOutput(this, "InputGuardArn", { value: inputGuard.fn.functionArn });
    new CfnOutput(this, "ToolCapArn", { value: toolCap.fn.functionArn });
    new CfnOutput(this, "ResultGuardArn", { value: resultGuard.fn.functionArn });
    new CfnOutput(this, "InputGuardrailId", { value: input.id });
    new CfnOutput(this, "InputGuardrailVersion", { value: input.version });
    new CfnOutput(this, "ToolResultGuardrailId", { value: toolResult.id });
    new CfnOutput(this, "ToolResultGuardrailVersion", { value: toolResult.version });
    // Paste into the harness config (CreateHarness/UpdateHarness `hooks`). The harness
    // execution role needs lambda:InvokeFunction on the three ARNs above.
    const target = (fn: lambda.IFunction) => ({
      lambda: { arn: fn.functionArn, timeoutSeconds: HOOK_TIMEOUT_SECONDS, failureMode: "deny" },
    });
    new CfnOutput(this, "HarnessHooksConfig", {
      value: this.toJsonString([
        { beforeInvocation: { name: "rxgrid_input_guard", target: target(inputGuard.fn) } },
        { beforeToolCall: { name: "rxgrid_tool_cap", target: target(toolCap.fn) } },
        { afterToolCall: { name: "rxgrid_result_guard", target: target(resultGuard.fn) } },
      ]),
    });
  }

  /**
   * A guardrail plus a pinned numbered version. The version description carries a hash of
   * the config, so any config change publishes a new version (a version never changes once
   * created, and the hooks call the version, not the mutable DRAFT).
   */
  private guardrail(id: string, props: bedrock.CfnGuardrailProps) {
    const g = new bedrock.CfnGuardrail(this, id, props);
    const hash = createHash("sha256").update(JSON.stringify(props)).digest("hex").slice(0, 12);
    const v = new bedrock.CfnGuardrailVersion(this, `${id}Version${hash}`, {
      guardrailIdentifier: g.attrGuardrailId,
      description: `config ${hash}`,
    });
    return { id: g.attrGuardrailId, arn: g.attrGuardrailArn, version: v.attrVersion };
  }

  /** Hook NodejsFunction with its own role that may write only to its own log group. */
  private hookFunction(id: string, dir: string, environment: Record<string, string>) {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `RxGrid ${dir} harness hook`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );
    const fn = new NodejsFunction(this, `${id}Fn`, {
      role,
      entry: path.join(repoRoot, `lambdas/hooks/${dir}/index.ts`),
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, "package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(HOOK_TIMEOUT_SECONDS - 2),
      logGroup,
      environment,
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: false, target: "node22" },
    });
    return { fn, role };
  }
}
