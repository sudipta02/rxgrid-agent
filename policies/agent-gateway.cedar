// DRAFT: Agent Gateway (inbound AWS_IAM, called by the harness execution role).
//
// Status: NOT yet validated against the Cedar schema that AgentCore generates from this
// gateway's tool manifest. That schema exists only after deploy. Before switching the
// gateway from LOG_ONLY to ENFORCE:
//   1. Fetch the generated schema for the deployed gateway and check the action name,
//      the principal type and the context.input fields used below.
//   2. Confirm the policy validated under FAIL_ON_ANY_FINDINGS (CloudFormation fails if not).
//   3. Replay the stress test and read the LOG_ONLY decisions in CloudWatch.
//
// Format (read by infra/lib/tools-stack.ts): each "// @policy <name>: <description>" line
// starts one AgentCore Policy resource. {{GATEWAY_ARN}} is replaced with this gateway's ARN
// at synth time; every action must be "<target>___<tool>" for a target this stack creates.
//
// Default deny: anything not permitted here (any other tool, MCP listing aside) is refused.

// @policy permit_search_inventory: Harness role may call search_inventory with a named drug (C1, R4)
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"rxgrid-search___search_inventory",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  // R4: no empty or wildcard queries. The Lambda also requires >= 3 characters
  // (Cedar has no string length operator).
  context.input.drug != "" &&
  context.input.drug != "*"
};
// TODO after the harness exists: narrow the principal to the harness execution role, e.g.
//   principal.id like "arn:aws:sts::<account>:assumed-role/<harness-role-name>/*"
// Check the exact principal.id format in a LOG_ONLY trace first.
