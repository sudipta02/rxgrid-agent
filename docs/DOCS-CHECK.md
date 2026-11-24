# AWS docs check: CLAUDE.md vs current AgentCore docs (2026-11-23)

These are the results of checking CLAUDE.md against the official AgentCore pages listed below. Items marked **VERIFY** were not settled by the docs and must be confirmed against a deployed resource before anyone relies on them.

## Mismatches and their impact

1. **Cedar never sees an inline `create_hold`.** Inline functions run on the client. The harness hands the call back to the caller with `stopReason: "tool_use"`. Cedar runs only on Gateway tool calls, and the hold Lambda's IAM is irrelevant if nothing invokes it. L4 and L5 therefore don't protect holds as CLAUDE.md describes.
   **Fix:** the inline `create_hold` becomes the human-confirm step. After the click, the app backend calls the Gateway `create_hold` tool with the user's JWT, which puts it under Cedar and the Lambda. The Gateway `create_hold` is *not* in the harness `allowedTools`, so the model can only reach it through confirmation.
2. **Hook payloads carry no JWT claims.** The fields are `hookEventId`, `name`, `event`, `harnessArn`, `sessionId` and `context`. A `before_tool_call` daily-cap hook can't know the pharmacy except from the model-written `toolInput`, which can't be trusted.
   **Fix:** add a `Sessions` table. The sanitizer writes sessionId → {pharmacy_id, role, sub} after verifying the JWT, and hooks look that up.
3. **Hooks only allow or deny. They can't redact.** An `after_tool_call` deny *keeps* the completed tool result and stops the invocation (`stopReason: hook_stopped`). The poisoned result may then stay in session history for the next turn.
   **Fix:** the sanitizer rotates to a new session after `hook_stopped`. The search Lambda returns `notes` in a clearly delimited data field.
4. **A check-then-write daily cap can be raced.** `before_tool_call` reads usage, and the write happens later. Two parallel requests can both pass.
   **Fix:** the authoritative cap is a conditional `TransactWriteItems` (Holds Put + DailyUsage Update) in the Lambda. The hook is an early, user-friendly deny.
5. **Cedar can't decide the Schedule X/H1 or ₹10,000 rules alone.** Policies see only `context.input` and principal tags. The drug's schedule and price aren't in the tool input unless the model supplies them, and that can't be trusted.
   **Fix:** `create_hold` takes a required `schedule` input. Cedar forbids H1/X unless `role == pharmacist`, and the Lambda rejects the request if the declared schedule differs from Inventory. The Lambda computes the ₹ check from the stored price.
6. **Omitting `allowedTools` is as dangerous as `"*"`.** Both resolve to the recommended built-in set, which includes `shell` and `read`/`write`/`edit`. CLAUDE.md warns only about `"*"`.
7. **InvokeHarness overrides are wider than CLAUDE.md lists.** The docs show per-call `tools`, `skills` and `model` (`modelId`, `apiBase`, `additionalParams`), and `allowedTools` is invocation-scoped. `apiBase` could reroute model traffic.
   **Fix:** the sanitizer builds the request from an allowlist instead of stripping a denylist.
8. **The server already rejects `toolUse` blocks, but `toolResult` is the live risk.** A `toolResult` is accepted when it answers a pending inline handoff in the same session. The sanitizer must refuse client-supplied `toolResult`. Only the backend's post-confirm path may send one.
9. **For Cedar to see `role` and `pharmacy_id`, the Gateway needs JWT inbound auth.** Claims become `OAuthUser` tags (`principal.hasTag` / `getTag`). Cognito *access* tokens don't include custom attributes by default, so a pre-token-generation trigger is needed.
   **VERIFY:** whether the harness forwards the end user's JWT to an `agentcore_gateway` tool. The security page says identity is threaded through for Bearer JWT inbound, but doesn't say which claims reach Gateway policy. If it doesn't, `list_holds` needs a fallback (Gateway interceptor, or a Sessions lookup in the Lambda).
10. **Cedar specifics for `policies/`:**
    - Action names are `AgentCore::Action::"<Target>___<tool>"`.
    - The resource must be the specific `AgentCore::Gateway::"<arn>"`, so policy files need an ARN placeholder filled at deploy.
    - There are no float literals: use `decimal("…")` or integers.
    - There is no regex, only `like`.
    - Validation defaults to `FAIL_ON_ANY_FINDINGS`.
    - Policies can be created only after the Gateway exists.
11. **VERIFY:** the exact `allowedTools` selector for Gateway tools. The docs show `@<server>/<tool>` patterns but don't say how a Gateway is named. Check after creating it.
12. **Confirmed as written in CLAUDE.md:**
    - The four hook events.
    - Lambda is the only blocking hook target. SNS and EventBridge only notify.
    - `failureMode` defaults to `deny`.
    - `after_invocation` can't retract streamed output.
    - LOG_ONLY / ENFORCE modes on the Gateway policy engine.
    - Default deny with forbid-wins.
    - Decisions are logged to CloudWatch.

## Sources

- [Harness lifecycle hooks](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html)
- [Harness tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)
- [Harness security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)
- [Policy getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html)
- [Policy schema constraints](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-schema-constraints.md)
- [Policy core concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)
- [Policy common patterns](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-common-patterns.md)
- [Example policies: principal](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/example-policies-principal.html)
- [GatewayPolicyEngineConfiguration API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GatewayPolicyEngineConfiguration.html)
