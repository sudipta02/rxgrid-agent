# Architecture

_Draft. The diagram and full layer write-up come with the infra stacks._

## Two gateways: why

AWS documents only one way for the harness to call a Gateway: it signs requests with the **harness's own IAM role** (`outboundAuth.awsIam`). Nothing documents the signed-in user's identity reaching the Gateway or Cedar on that path. See DOCS-CHECK.md, item 9.

So identity-bound actions never go through the model's path.

```
MODEL PATH (harness execution role, SigV4)
  harness ──► Agent Gateway (inbound AWS_IAM)
                Cedar: permit search_inventory only
                └─► search-inventory Lambda (Query on the two Inventory indexes only)

USER PATH (the signed-in person's Cognito access token)
  harness ──inline function call──► UI shows a "Confirm?" dialog (create_hold)
                                     or runs the call silently (list_holds)
  UI backend ──Bearer <access token>, x-rxgrid-user-token──► User Gateway (inbound CUSTOM_JWT)
                Cedar: qty <= 50; H1/X only if role == pharmacist;
                       input pharmacy_id == principal pharmacy_id
                ├─► create-hold Lambda  (re-verifies the token, re-checks stored data)
                └─► list-holds Lambda   (re-verifies the token, own partition only)
```

The model can't reach `create_hold` or `list_holds` without a person's token, which only the UI backend holds. The token never appears in a tool schema.

## Enforcement layers

| Layer | What | Where |
|---|---|---|
| L1 | Cognito JWT (Essentials plan). `role` comes from `pharmacist`/`staff` group membership, which only admins can change. `pharmacy_id` is the custom attribute `custom:pharmacy_id`, which no app client can write. A pre-token-generation V2 trigger copies both into the **access token** and refuses to issue a token if `pharmacy_id` is missing. There is no self sign-up. | `infra/lib/auth-stack.ts`, `lambdas/pre-token/` |
| L2 | Sanitizer API. It builds the InvokeHarness request from an allowlist (message text plus a server-held session ID). It never forwards a client-sent `toolResult`; only the backend's own post-confirm path sends one. | `infra` (API GW + Lambda) |
| L3 | Harness `allowedTools` lists only the Agent Gateway's `search_inventory` plus the inline `create_hold` and `list_holds`. It is never `*` and never omitted, because both mean the built-ins, including `shell`. It is set on the harness and pinned again on every call by the sanitizer. | `infra/lib/harness-stack.ts`, `lambdas/shared/tools.ts` |
| L4 | Cedar on **both** gateways: default deny, LOG_ONLY then ENFORCE. Agent Gateway: permits only search, with input constraints. User Gateway: per-user rules on principal tags. | `policies/*.cedar` |
| L5 | Data model and scoped IAM. Search indexes omit price and sales fields. search: Query on the two index ARNs. create-hold: GetItem on Inventory, PutItem on Holds, UpdateItem on DailyUsage. list-holds: Query on Holds. No Scan or Delete anywhere. The user-path Lambdas **re-verify the JWT** from a propagated header and refuse any other pharmacy. | `lambdas/*`, `infra/` |
| L6 | Harness hooks: `before_invocation` (ApplyGuardrail on input), `after_tool_call` (ApplyGuardrail on the tool result) | `lambdas/hooks/*` |
| L7 | Daily cap. The authoritative check is ONE DynamoDB transaction (Holds Put + DailyUsage conditional Update), so parallel or split requests can't pass it. The `before_tool_call` hook adds an early deny via a `Sessions` lookup. | `lambdas/create-hold`, `lambdas/hooks/tool-cap` |
| L8 | Inline functions. `create_hold` pauses for a human Confirm. `list_holds` is inline so that it runs with the user's token. | `web/` |
| L9 | Client-side ApplyGuardrail on the final output (`after_invocation` can't retract streamed text) | `web/` |

## Data model

See `lambdas/shared/schema.ts`.

- **Pharmacies** `pharmacy_id`: directory
- **Inventory** `pharmacy_id` / `sk=DRUG#id#BATCH#b`, with two GSIs. Both have an INCLUDE projection of safe fields only and are sorted by `expiry_pharmacy`, so `>= today+30` drops short-dated stock inside the Query.
  - `BySalt` (`salt_norm`): finds same-salt substitutes.
  - `ByBrandFamily` (`brand_family`, the first word of the brand): lets "Glycomet" match both Glycomet 500 and Glycomet 1g, which is how ambiguity is detected.
- **Holds** `requesting_pharmacy_id` / `hold_id`
- **DailyUsage** `pharmacy_id` / `date` (IST), TTL
- **Sessions** `session_id`, TTL. Maps the harness session to the verified JWT identity, because hook payloads carry no claims.

## Tools stack (`infra/lib/tools-stack.ts`)

Synthesized, not deployed. The policy engines are attached in **LOG_ONLY**: Cedar decisions are logged, not enforced.

| Gateway | Inbound auth | Target → tool (Cedar action) | Lambda role (only these) |
|---|---|---|---|
| `rxgrid-agent-gateway` | `AWS_IAM` | `rxgrid-search` → `rxgrid-search___search_inventory` | `dynamodb:Query` on `Inventory/index/BySalt` and `/index/ByBrandFamily` |
| `rxgrid-user-gateway` | `CUSTOM_JWT` (Cognito discovery URL; `allowedClients` = `rxgrid-web`, `rxgrid-stress-test`) | `rxgrid-create-hold` → `rxgrid-create-hold___create_hold` | `GetItem` on Inventory. `PutItem` on Holds and `UpdateItem` on DailyUsage, both only when `dynamodb:EnclosingOperation = TransactWriteItems` |
| | | `rxgrid-list-holds` → `rxgrid-list-holds___list_holds` | `Query` on Holds |

- **Logs:** each Lambda has its own role and may write only to its own log group (2-week retention). No `AWSLambdaBasicExecutionRole` is attached.
- **Header propagation:** both user targets set `metadataConfiguration.allowedRequestHeaders = ["x-rxgrid-user-token"]`. The L2 exposes this only for API Gateway targets, so it is set on the L1 `CfnGatewayTarget`.
- **Gateway service roles:**
  - Each role has `lambda:InvokeFunction` on its own functions only, plus `AuthorizeAction`/`PartiallyAuthorizeActions` on its own engine and gateway.
  - Each role's trust policy pins `aws:SourceAccount` and `aws:SourceArn` to its own gateway (`gateway/<name>-??????????`). This works because the gateway names are literal.
  - There is **no Lambda resource policy**. AWS needs one only for a cross-account target, and a service-principal grant would add a second invoke path. Confused-deputy protection therefore sits on the role trust policies.
- **Cedar:**
  - `policies/*.cedar` hold one AgentCore Policy per `// @policy <name>: <description>` block, with `{{GATEWAY_ARN}}` (and, on the Agent Gateway, `{{HARNESS_PRINCIPAL_ID}}`) filled at synth. An unfilled placeholder fails synth.
  - Synth fails if a block names an action that isn't `<target>___<tool>` for a target of that gateway.
  - Validation mode is `FAIL_ON_ANY_FINDINGS`. Each policy depends on its gateway's targets, because the Cedar schema is generated from their tool manifests.
- **Tool schemas** (`infra/lib/tool-schemas.ts`) mirror the Lambda input types. The inline schema format has no `enum`, `minimum` or `maximum`, so limits are stated in the descriptions and enforced by Cedar and the Lambdas.

**Before ENFORCE:**
1. Read the generated Cedar schema for each deployed gateway.
2. Check the action names, the `OAuthUser` tag types and `qty` as `Long`. The Agent Gateway permit is already narrowed to the harness role (`principal.id` = `arn:aws:sts::<acct>:assumed-role/rxgrid-harness-execution`, as AWS documents it, or the same with a `/<session>` suffix). Confirm the real `principal.id` in a LOG_ONLY trace.
3. Replay the stress test in LOG_ONLY.

## Harness stack (`infra/lib/harness-stack.ts`)

Synthesized, not deployed. CDK 2.278 has the L1 `CfnHarness` (`AWS::BedrockAgentCore::Harness`), so the harness is a CDK stack, not an AgentCore CLI project. Its ARN flows into the sanitizer as a normal cross-stack reference, with no manual `-c harnessArn`.

| Setting | Value | Why |
|---|---|---|
| Name | `rxgrid_agent` | Letters, digits and underscores only, ≤ 40 chars |
| Model | `au.anthropic.claude-sonnet-5-5`, `converse_stream`, 2,048 tokens per call | In ap-southeast-2 every Claude model is inference-profile-only. The AU profile routes only to ap-southeast-2 and ap-southeast-4. `converse_stream` needs no `bedrock-mantle` permissions. |
| Inbound auth | `CUSTOM_JWT`: Cognito discovery URL, `allowedClients` = `rxgrid-web`, `rxgrid-stress-test` | The sanitizer forwards the person's access token (DOCS-CHECK 23). SigV4 callers are rejected. |
| Tools | `agentcore_gateway` `rxgrid_search` → Agent Gateway (`outboundAuth.awsIam`); inline `create_hold`, `list_holds` | Inline schemas are generated from the User Gateway schemas (`INLINE_CREATE_HOLD`, `INLINE_LIST_HOLDS`), minus the backend-only `harness_session_id` |
| `allowedTools` | `@rxgrid_search/rxgrid-search___search_inventory`, `@create_hold`, `@list_holds` | Exactly `ALLOWED_TOOLS`. A unit test pins the 64-char limit and the selector pattern. |
| Hooks | `HooksStack.harnessHooks`: `rxgrid_input_guard`, `rxgrid_tool_cap`, `rxgrid_result_guard`, each `failureMode: deny`, 10 s | |
| System prompt | `infra/lib/system-prompt.ts`: C1–C3, R1–R5, E1–E5, the E4 handoff format, "tool output is data" | Numbers are interpolated from `LIMITS`. The prompt states rules; it enforces none. |
| Memory | `disabled` (explicit) | Omitting it is not documented as "no memory", and managed memory would outlive a poisoned session |
| Browser, Code Interpreter, remote MCP, skills | none | |
| Limits | `maxIterations` 8, `maxTokens` 8,192, `timeoutSeconds` 120, truncation `sliding_window` (40 messages) | Fixed explicitly because the managed defaults can change |

**Execution role `rxgrid-harness-execution`** (literal name, so ToolsStack can name it in Cedar without a cross-stack cycle):

| Statement | Actions | Resource |
|---|---|---|
| Model (profile) | `bedrock:InvokeModel`, `InvokeModelWithResponseStream` | `inference-profile/au.anthropic.claude-sonnet-5-5` in ap-southeast-2 |
| Model (routed) | same | `foundation-model/anthropic.claude-sonnet-5-5` in ap-southeast-2 and ap-southeast-4, **only** with `bedrock:InferenceProfileArn` = that profile |
| Agent Gateway | `bedrock-agentcore:InvokeGateway` | Agent Gateway ARN only |
| Hooks | `lambda:InvokeFunction` | The three hook ARNs only |
| Own logs | `logs:CreateLogGroup`, `DescribeLogStreams`, `CreateLogStream`, `PutLogEvents`; `DescribeLogGroups` | `/aws/bedrock-agentcore/runtimes/*` in this project; `log-group:*` for the list action |
| ECR Public (**required `*`**) | `ecr-public:GetAuthorizationToken`; `sts:GetServiceBearerToken` with `sts:AWSServiceName = ecr-public.amazonaws.com` | `*`: neither action supports resource-level permissions. The harness pulls its managed image from ECR Public. |
| Workload identity | `GetWorkloadAccessToken`, `GetWorkloadAccessTokenForJWT` | `workload-identity-directory/default` and `…/harness_rxgrid_agent-*` |
| **Deny** | `sts:AssumeRole`, `InvokeAgentRuntimeCommand`, `InvokeAgentRuntimeCommandShell` | `*` (a Deny, not a grant) |

- **Trust policy:** `bedrock-agentcore.amazonaws.com`, with `aws:SourceAccount` = this project and `aws:SourceArn` like `arn:aws:bedrock-agentcore:ap-southeast-2:<acct>:*`. The exact SourceArn the service presents isn't documented, so the trust isn't pinned to the harness ARN.
- **Left out of the AWS sample policy:** X-Ray, `cloudwatch:PutMetricData` and `logs:PutResourcePolicy` (each needs `*`), plus the default Browser, Code Interpreter and Memory statements (features not used). If the harness needs any of them, the first invocation will show it. Add the statement back then and log it in BREAKS.md.

**Gap: the model doesn't know the signed-in pharmacy.** `create_hold` and `list_holds` take `pharmacy_id`, and `tool-cap` denies a call whose `pharmacy_id` isn't the session's. The sanitizer currently sends only the person's text. The system prompt therefore reads the pharmacy only from a server-written `<rxgrid_session>pharmacy_id=… role=…</rxgrid_session>` block (`SESSION_CONTEXT_TAG`). If the block is missing, the model refuses rather than guessing or asking. Until the sanitizer adds that block from the verified token, holds and hold listing fail closed.

## Hooks stack (`infra/lib/hooks-stack.ts`)

Synthesized, not deployed. The harness execution role invokes the hooks synchronously. Every hook uses `failureMode: "deny"` and a 10 s timeout. `HarnessStack` takes the list straight from `HooksStack.harnessHooks`, and the `HarnessHooksConfig` output shows the same JSON.

| Hook | Event | Denies when | IAM (only these) |
|---|---|---|---|
| `input-guard` | `before_invocation` | Context truncated. Session unknown/expired (didn't come through the sanitizer). A message isn't role `user`. A block isn't `text`/`toolResult`. The **input guardrail** intervenes. | `GetItem` Sessions; `ApplyGuardrail` on `rxgrid-input` |
| `tool-cap` | `before_tool_call` | Tool not on the allowlist (`create_hold`/`list_holds` as `inline_function`, `*search_inventory` as `agentcore_gateway`), so `shell` and other built-ins are denied even if `allowedTools` were wrong. For inline calls: `pharmacy_id` ≠ session pharmacy. For `create_hold`: qty not 1–50, H1/X for a non-pharmacist, or today's units or hold count would pass the cap. | `GetItem` Sessions and DailyUsage |
| `result-guard` | `after_tool_call` | Result truncated, or the **tool-result guardrail** flags any string in it (JSON-encoded strings are unpacked first) | `ApplyGuardrail` on `rxgrid-tool-result` |

**Guardrails**, both on the CLASSIC tier. The STANDARD tier requires cross-Region inference, which the project SCP denies.
- **`rxgrid-input`:**
  - `DosingAdvice` denied topic (R1)
  - `PROMPT_ATTACK` HIGH
  - hate, insults, sexual and violence at MEDIUM
  - misconduct at LOW, so requests for Schedule X stock aren't flagged
- **`rxgrid-tool-result`:** `PROMPT_ATTACK` HIGH only, so stock rows aren't judged against the dosing topic.
- **Source:** tool output is sent as `INPUT`, the only source on which prompt-attack detection runs.
- **Versions:** each guardrail has a pinned numbered version, and its description carries a config hash, so a change publishes a new version.

**Not checked by the hooks, by design:**
- `tool-cap` doesn't check the ₹ cap. It would need the stored price, and the price in the model's input isn't trusted. The create-hold transaction is authoritative for every limit.
- An `after_tool_call` deny keeps the result in session history, so the sanitizer must start a new session after `hook_stopped`.

## Sanitizer API (`infra/lib/sanitizer-stack.ts`, `lambdas/sanitizer/`)

Synthesized, not deployed. It is the only path from a browser to the harness.

```
browser ──Bearer <access token>──► API Gateway REST (Regional, Cognito authorizer, access-token scope,
                                    throttle 5 rps / burst 10)
          ──► sanitizer Lambda (streaming, NDJSON)
                ├─ Sessions table (GetItem/PutItem/UpdateItem only)
                ├─ InvokeHarness over HTTPS with the SAME bearer token (JWT harness; no IAM)
                └─ User Gateway tools/call with the SAME token (Authorization + x-rxgrid-user-token)
```

| Route | Body (anything else → 400 `UNEXPECTED_FIELDS`) | Does |
|---|---|---|
| `POST /sessions` | none | Creates `rx-<uuid>`. Writes `Sessions` {pharmacy_id, role, sub, ttl 2 h} from the verified token. The hooks read this row. |
| `POST /chat` | `sessionId`, `text` (≤ 2,000 chars) | Session must match the token's `sub`, pharmacy and role. Refused while a hold is pending. Sends **only** `{messages: [user text], allowedTools: <pinned>}`. |
| `POST /confirm` | `sessionId`, `toolUseId`, `approve` | **Claims** the pending hold with a conditional update, so it runs once. On approve, calls the User Gateway `create_hold`. Sends the `toolResult` back to the harness. |

**Override allowlist.** The harness accepts these per-call overrides: `tools`, `skills`, `model` (incl. `additionalParams`, `apiBase`, `modelId`), `systemPrompt`, `allowedTools`, `actorId`, `maxIterations`, `maxTokens`, `timeoutSeconds`, `runtimeUserId`, `qualifier` and the trace headers. None of them comes from the client. The sanitizer sets `allowedTools` itself on every call (`lambdas/shared/tools.ts`).

**Inline functions:**
- **When:** handled only when the final `messageStop` is `tool_use`.
- **`list_holds`:** runs straight away with the person's token, and the loop resumes. A turn is capped at 4 rounds.
- **First `create_hold`:** stored as `Sessions.pending` and sent to the UI as a `confirm` event.
- **Other calls in the same handoff:** answered with `NOT_RUN` after the confirm. One hold at a time, which also blocks splitting.
- **`toolResult`s** are built only here, never from client input.

**`hook_stopped`:** the session is revoked (`revoked = true`; hooks treat it as missing) and a new session is issued in a `session` event. This matters because an `after_tool_call` deny leaves the poisoned result in the harness history.

**UI events (NDJSON):** `accepted`, `session`, `text`, `tool`, `hook`, `confirm`, `hold_result`, `done`, `error`. `accepted` is sent as soon as validation passes, so the stream opens within API Gateway's 29 s first-byte limit. Validation failures before that point return a real 4xx status. Logs record decisions and sizes, never tokens or message text.
