// DRAFT: User Gateway (inbound CUSTOM_JWT, Cognito access tokens from rxgrid-web and
// rxgrid-stress-test). Only the UI backend calls it, with the signed-in person's token.
// The pre-token trigger puts `pharmacy_id` and `role` claims into the access token; AgentCore
// exposes JWT claims as principal tags (principal.hasTag / principal.getTag).
//
// Status: NOT yet validated against the Cedar schema that AgentCore generates from this
// gateway's tool manifest. That schema exists only after deploy. Before switching the
// gateway from LOG_ONLY to ENFORCE:
//   1. Fetch the generated schema and check action names, the OAuthUser tag type, and that
//      qty is typed Long (JSON Schema "integer") and schedule/pharmacy_id are String.
//   2. Confirm each policy validated under FAIL_ON_ANY_FINDINGS.
//   3. Replay the stress test and read the LOG_ONLY decisions in CloudWatch.
//
// Format (read by infra/lib/tools-stack.ts): each "// @policy <name>: <description>" line
// starts one AgentCore Policy resource. {{GATEWAY_ARN}} is filled at synth time.
//
// Default deny; forbid always wins over permit. Each forbid guards getTag with hasTag inside
// `unless { ... && ... }`, so a missing claim short-circuits to "forbid applies" instead of an
// evaluation error (an erroring forbid is skipped, which would fail open).

// @policy permit_list_holds_own: A signed-in user may list their own pharmacy's holds (C2)
permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"rxgrid-list-holds___list_holds",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  principal.hasTag("pharmacy_id") &&
  context.input.pharmacy_id == principal.getTag("pharmacy_id")
};

// @policy permit_create_hold_own: A signed-in user may create a hold for their own pharmacy, 1-50 units (C3)
permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"rxgrid-create-hold___create_hold",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  principal.hasTag("pharmacy_id") &&
  principal.hasTag("role") &&
  context.input.pharmacy_id == principal.getTag("pharmacy_id") &&
  context.input.qty >= 1 &&
  context.input.qty <= 50
};

// @policy forbid_other_pharmacy: Nobody may act for a pharmacy other than the one in their token (C2, R5)
forbid(
  principal is AgentCore::OAuthUser,
  action in [
    AgentCore::Action::"rxgrid-list-holds___list_holds",
    AgentCore::Action::"rxgrid-create-hold___create_hold"
  ],
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) unless {
  principal.hasTag("pharmacy_id") &&
  context.input.pharmacy_id == principal.getTag("pharmacy_id")
};

// @policy forbid_qty_over_limit: No single hold over 50 units, whatever else is permitted (C3, E4)
forbid(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"rxgrid-create-hold___create_hold",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  context.input.qty > 50
};

// @policy forbid_restricted_schedule_non_pharmacist: Schedule H1/X holds only for JWT role pharmacist (R2)
forbid(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"rxgrid-create-hold___create_hold",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
) when {
  context.input.schedule == "H1" || context.input.schedule == "X"
} unless {
  principal.hasTag("role") &&
  principal.getTag("role") == "pharmacist"
};
