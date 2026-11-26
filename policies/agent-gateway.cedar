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
// and {{HARNESS_PRINCIPAL_ID}} with the harness role's principal id at synth time; every
// action must be "<target>___<tool>" for a target this stack creates.
//
// Default deny: anything not permitted here (any other tool, MCP listing aside) is refused.

// @policy permit_search_inventory: Only the harness execution role may call search_inventory with a named drug (C1, R4)
permit(
  principal is AgentCore::IamEntity,
  action == AgentCore::Action::"rxgrid-search___search_inventory",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  // Only the RxGrid harness (infra/lib/harness-stack.ts, role rxgrid-harness-execution).
  // {{HARNESS_PRINCIPAL_ID}} = arn:aws:sts::<account>:assumed-role/rxgrid-harness-execution.
  // AWS documents IamEntity.id as the assumed-role ARN WITHOUT a session name; the `like`
  // arm also accepts the form with one, so a docs/runtime mismatch fails neither way.
  // VERIFY in a LOG_ONLY trace before ENFORCE.
  (principal.id == "{{HARNESS_PRINCIPAL_ID}}" ||
   principal.id like "{{HARNESS_PRINCIPAL_ID}}/*") &&
  // R4: no empty or wildcard queries. The Lambda also requires >= 3 characters
  // (Cedar has no string length operator).
  context.input.drug != "" &&
  context.input.drug != "*"
};
