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
   **RESOLVED (2026-11-26) by design.** Harness → Gateway outbound auth has three options: `awsIam`, `none` and `oauth`.
   - `awsIam` "SigV4-sign[s] requests using the agent's execution role".
   - `oauth` rejects the `AUTHORIZATION_CODE` grant for this path.
   - No page documents the end user's JWT or claims reaching the Gateway or Cedar.

   So we use **two gateways** (see ARCHITECTURE.md). The model's gateway serves only `search_inventory`. `list_holds` and `create_hold` are inline functions that the UI backend runs on a JWT-authorised User Gateway with the person's own token.
10. **Cedar specifics for `policies/`:**
    - Action names are `AgentCore::Action::"<Target>___<tool>"`.
    - The resource must be the specific `AgentCore::Gateway::"<arn>"`, so policy files need an ARN placeholder filled at deploy.
    - There are no float literals: use `decimal("…")` or integers.
    - There is no regex, only `like`.
    - Validation defaults to `FAIL_ON_ANY_FINDINGS`.
    - Policies can be created only after the Gateway exists.
11. ~~**VERIFY:** the exact `allowedTools` selector for Gateway tools.~~ **RESOLVED (2026-11-26):** `@<name>/<target>___<tool>`, where `<name>` is the `name` of the `agentcore_gateway` entry in the harness `tools` (here `rxgrid_search`). Each entry may be 1–64 characters ([harness-tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)). Ours is 47.
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

## Tools stack checks (2026-11-26, CDK 2.278 + AWS docs)

13. **Tool name separator is `___`.** The Cedar example in the AWS docs uses `RefundTool___process_refund`. The CDK README text says `__`, which is wrong.
14. **Header propagation works on Lambda targets.** Propagated headers arrive in `clientContext.custom.bedrockAgentCorePropagatedHeaders` as a nested object by default. Constraints on header names:
    - `Authorization` can't be allow-listed.
    - Names must match `^[a-zA-Z0-9_-]+$`.
    - `X-Amzn-*` is prohibited.

    `x-rxgrid-user-token` is fine. The CDK L2 Lambda target has no `metadataConfiguration`, so it is set on the L1 ([gateway-headers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-headers.html)).
15. **Same-account Lambda targets need only an identity policy on the gateway role.** A resource-based policy is for cross-account only ([gateway-prerequisites-permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-prerequisites-permissions.html)).
16. **DynamoDB transactions are authorised per item action.** `TransactWriteItems` needs `PutItem` and `UpdateItem`; there is no separate IAM action. `dynamodb:EnclosingOperation` can restrict those actions to transactions ([transaction-apis-iam](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)).
17. **Cedar types from the tool schema:** JSON `integer` maps to `Long`, `string` to `String`, and `number` to `Decimal`. `required` decides which `context.input` fields always exist. The IAM principal is `AgentCore::IamEntity` (`id` = caller ARN). The JWT principal is `AgentCore::OAuthUser` (claims as tags) ([policy-schema-constraints](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-schema-constraints.md)).
18. **Inline tool schemas support only `type`, `description`, `items`, `properties` and `required`.** That holds for both CDK `SchemaDefinition` and CFN, so there are no enum or min/max constraints.

## Hooks stack checks (2026-11-26)

19. **The harness execution role invokes hook Lambdas.** The call is synchronous (`RequestResponse`) and needs only an identity policy in the same account. `before_tool_call` and `after_tool_call` also fire for `inline_function` tools. For an inline call, `toolResult` is the client-supplied result ([harness-lifecycle-hooks](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html)).
20. **Truncation doesn't trigger `failureMode`.** Context is capped at 64 KiB. For `before_invocation`, `context.truncated = true` is set. Other events replace fields with `{truncated: true, preview}`. Hooks must deny these themselves. When several Lambda hooks share an event, they run concurrently, and any deny wins.
21. **The Guardrails STANDARD tier requires cross-Region inference**, so this project uses CLASSIC. CLASSIC supports English, French and Spanish. `ApplyGuardrail` IAM scopes to `arn:aws:bedrock:<region>:<acct>:guardrail/<id>`.
22. **Partly settled (2026-11-26):** `toolType` is one of `builtin`, `remote_mcp`, `agentcore_gateway` or `inline_function`. `toolName` is the "model-facing tool name" ([harness-lifecycle-hooks](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html)). **Still VERIFY after the harness exists:** whether that name for the Gateway search tool is `rxgrid-search___search_inventory` or carries a `rxgrid_search` prefix. `tool-cap` accepts `agentcore_gateway` names ending in `search_inventory`. Also check the shape of `toolResult` for Gateway tools. `result-guard` collects every string leaf, so it doesn't depend on that shape.

## Sanitizer API checks (2026-11-26)

23. **A JWT harness is invoked over HTTPS with `Authorization: Bearer`:** `POST https://bedrock-agentcore.<region>.amazonaws.com/harnesses/invoke?harnessArn=…` with `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (33–256 chars). The JS SDK `InvokeHarnessCommand` signs with SigV4 only, so the sanitizer uses `fetch`. SigV4 callers would need `bedrock-agentcore:InvokeHarness` **and** `InvokeAgentRuntime` ([harness-security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)).
24. **The response is an AWS binary event stream:** `messageStart`, `contentBlockStart/Delta/Stop`, `messageStop`, `metadata`, `hookEvent`, plus exception frames. `EventStreamCodec.decode` needs whole frames, so the sanitizer reassembles them from the 4-byte length prelude (caught by a unit test).
25. **InvokeHarness overrides** are wider than first listed: `actorId`, `allowedTools`, `maxIterations`, `maxTokens`, `messages`, `model`, `qualifier`, `runtimeUserId`, `skills`, `systemPrompt`, `timeoutSeconds`, `tools` and the trace headers. AWS states that `model.additionalParams` can redirect the signed model request to any endpoint or attempt role assumption, and that `skills` content is trusted.
26. **Inline flow:** read the whole stream and act only if the last `messageStop` is `tool_use`. Send the matching `toolResult` in a later call on the same session. A result with no matching pending handoff can't resume anything. ~~**VERIFY:** the exact `toolResult` block shape.~~ **RESOLVED (2026-11-26):** the docs' inline-function example sends `{toolResult: {toolUseId, content: [{text}], status: "success"}}` in a `user` message on the same `runtimeSessionId`, which is what the sanitizer sends. Adjacent inline results go back together in one follow-up request ([harness-tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html)).
27. **API Gateway REST response streaming:** up to 15 min, 5 min idle (Regional), and `AWS_PROXY`/`HTTP_PROXY` only. CDK `ResponseTransferMode.STREAM` switches to the `response-streaming-invocations` URI. The first byte must still arrive within the integration timeout (29 s default), hence the early `accepted` event. A REST Cognito authorizer validates **access** tokens only when the method sets `authorizationScopes`.
28. **A CloudFormation `AWS::BedrockAgentCore::Harness` resource exists**, so the harness could be defined in CDK instead of the AgentCore CLI. **Done:** CDK 2.278 has the L1 `CfnHarness`, used by `RxGrid-Harness` (items 29–37).

## Harness stack checks (2026-11-26, CDK 2.278 + AWS docs + read-only Bedrock API calls)

29. **`CfnHarness` covers everything we need:** model, systemPrompt, tools, allowedTools, hooks, authorizerConfiguration, memory, truncation and limits. `attrArn` and `attrHarnessId` are exported, so the sanitizer gets the ARN by cross-stack reference. The schema converter is needed because the L2 `SchemaDefinitionType` is a class (`.value`), while `inlineFunction.inputSchema` is plain JSON. `harnessName` must start with a letter, use only letters, digits and underscores, and be ≤ 40 chars ([CreateHarness](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateHarness.html)).
30. **Claude in ap-southeast-2 is inference-profile-only.** `ListFoundationModels` reports `INFERENCE_PROFILE` as the only inference type for every Anthropic model. `ListInferenceProfiles` shows `au.*` profiles routing to ap-southeast-2 + ap-southeast-4, and `global.*` profiles routing worldwide. We use `au.anthropic.claude-sonnet-5-5`. IAM needs the profile ARN plus the foundation model in **every** destination Region, conditioned on `bedrock:InferenceProfileArn` ([geographic-cross-region-inference](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)).
31. **The project SCP does not block cross-Region inference.** Its `RegionFloor` statement denies by `aws:RequestedRegion`, but its `NotAction` exempts `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:ApplyGuardrail`, `bedrock:GetInferenceProfile` and the other inference read actions ([scps-and-rcps-for-projects](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html)). So the ap-southeast-4 leg of the AU profile is allowed. **This also undercuts the reasoning in item 21:** the STANDARD guardrail tier may work after all. CLASSIC remains a valid choice, but the stated reason should be re-checked rather than repeated.
32. **Execution role per the sample policy** ([harness-security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-security.html)):
    - Trust: `bedrock-agentcore.amazonaws.com`.
    - Required: `ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`, both `Resource: "*"`, because the managed image is pulled from ECR Public.
    - Also in the sample: logs under `/aws/bedrock-agentcore/runtimes/*` and workload identity (`harness_<name>-*`).
    - Per feature: `InvokeGateway` on a SigV4 gateway, and `lambda:InvokeFunction` on each hook target.
    - We leave out X-Ray, `cloudwatch:PutMetricData`, `logs:PutResourcePolicy` and the Browser, Code Interpreter and Memory defaults. **VERIFY after deploy** that the harness starts and logs without them.
33. **Memory has an explicit `disabled` member**, and the CreateHarness IAM table lists `CreateMemory`. We set `memory: {disabled: {}}` rather than rely on omission.
34. **The `IamEntity` principal id is `arn:aws:sts::<account>:assumed-role/<role-name>`**, documented without a session name ([policy-core-concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)). The Agent Gateway permit accepts that string, or the same followed by `/<session>`. **VERIFY** in a LOG_ONLY trace before ENFORCE.
35. **Bedrock `apiFormat` values:** `converse_stream | responses | chat_completions`. Only the last two need `bedrock-mantle` permissions. Truncation strategies are `sliding_window | summarization | none`. When `systemPrompt` or `truncation` is omitted, the harness uses managed defaults that can change, so both are set explicitly ([harness-models](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html)).
36. **Hooks with inline functions:** `before_tool_call` runs before the handoff and is not repeated on resume. `after_tool_call` runs once with the client-supplied result, which it "does not attest" was really executed. Hooks are configured only on Create/UpdateHarness and can't be overridden per call ([harness-lifecycle-hooks](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html)).
37. **VERIFY after deploy:**
    - The `aws:SourceArn` the service presents when assuming the execution role. The trust is pinned to the account's `bedrock-agentcore` ARNs only.
    - The runtime log-group name, so `runtimes/*` can be narrowed.
    - Whether invoking without a `qualifier` reaches the harness's default endpoint. The stack creates no `HarnessEndpoint`.
