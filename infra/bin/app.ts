import { App } from "aws-cdk-lib";
import { DataStack } from "../lib/data-stack.js";
import { AuthStack } from "../lib/auth-stack.js";

const app = new App();

// The AWS project is locked to ap-southeast-2 by an org SCP, so other Regions are denied.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" };

new DataStack(app, "RxGrid-Data", {
  env,
  description: "RxGrid stock-transfer agent: DynamoDB tables",
});

new AuthStack(app, "RxGrid-Auth", {
  env,
  description: "RxGrid stock-transfer agent: Cognito users, groups and token claims",
});

// Next stacks: Tools (Lambdas + Gateway + Policy engine), Hooks, Sanitizer API.
// The harness itself is defined via the AgentCore CLI.
