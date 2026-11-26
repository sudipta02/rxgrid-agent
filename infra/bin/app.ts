import { App } from "aws-cdk-lib";
import { DataStack } from "../lib/data-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { ToolsStack } from "../lib/tools-stack.js";
import { HooksStack } from "../lib/hooks-stack.js";

const app = new App();

// The AWS project is locked to ap-southeast-2 by an org SCP, so other Regions are denied.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" };

const data = new DataStack(app, "RxGrid-Data", {
  env,
  description: "RxGrid stock-transfer agent: DynamoDB tables",
});

const auth = new AuthStack(app, "RxGrid-Auth", {
  env,
  description: "RxGrid stock-transfer agent: Cognito users, groups and token claims",
});

new ToolsStack(app, "RxGrid-Tools", {
  env,
  description: "RxGrid stock-transfer agent: tool Lambdas, Agent and User AgentCore Gateways, Cedar policy engines",
  inventory: data.inventory,
  holds: data.holds,
  dailyUsage: data.dailyUsage,
  userPool: auth.userPool,
  userClients: [auth.webClient, auth.stressTestClient],
});

new HooksStack(app, "RxGrid-Hooks", {
  env,
  description: "RxGrid stock-transfer agent: harness lifecycle-hook Lambdas and Bedrock Guardrails",
  sessions: data.sessions,
  dailyUsage: data.dailyUsage,
});

// Next stack: Sanitizer API. The harness itself is defined via the AgentCore CLI.
