# Architecture

_Draft. The diagram and full layer write-up come with the infra stacks._

## Enforcement layers (as revised after the AWS docs check, see DOCS-CHECK.md)

| Layer | What | Where |
|---|---|---|
| L1 | Cognito JWT (Essentials plan). `role` comes from `pharmacist`/`staff` group membership, which only admins can change. `pharmacy_id` is the custom attribute `custom:pharmacy_id`, which no app client can write. A pre-token-generation V2 trigger copies both into the **access token** and refuses to issue a token if `pharmacy_id` is missing. There is no self sign-up. | `infra/lib/auth-stack.ts`, `lambdas/pre-token/`. Consumed by harness `customJWTAuthorizer` and Gateway inbound JWT |
| L2 | Sanitizer API. It builds the InvokeHarness request from an allowlist (message text plus a server-held session ID) instead of stripping fields from the client's body. It writes the `Sessions` row. | `infra` (API GW + Lambda) |
| L3 | `allowedTools` lists only `search_inventory`, `list_holds` and the inline `create_hold`. It is never `*` and never omitted, because both mean the built-ins, including `shell`. | Harness config |
| L4 | Cedar policy engine on the Gateway: default deny, LOG_ONLY then ENFORCE | `policies/*.cedar` |
| L5 | Data model and scoped IAM. Search indexes omit price and sales fields. Query only on index ARNs. PutItem only on Holds. No Scan or Delete. | `lambdas/shared/schema.ts`, `infra/lib/data-stack.ts` |
| L6 | Harness hooks: `before_invocation` (ApplyGuardrail on input), `after_tool_call` (ApplyGuardrail on the tool result) | `lambdas/hooks/*` |
| L7 | Daily cap. The authoritative check is a conditional transaction in the create-hold Lambda. The `before_tool_call` hook adds an early deny via a `Sessions` lookup. | `lambdas/create-hold`, `lambdas/hooks/tool-cap` |
| L8 | `create_hold` is an inline function. The harness pauses, the UI confirms, and then the backend calls the Gateway tool with the user's JWT. | `web/` |
| L9 | Client-side ApplyGuardrail on the final output (`after_invocation` can't retract streamed text) | `web/` |

## Data model

See `lambdas/shared/schema.ts`.

- **Pharmacies** `pharmacy_id`: directory
- **Inventory** `pharmacy_id` / `sk=DRUG#id#BATCH#b`
  - GSI `BySaltStrength` (`salt_strength` / `expiry_pharmacy`) and GSI `ByBrand` (`brand_norm` / `expiry_pharmacy`), both with an INCLUDE projection of safe fields only
- **Holds** `requesting_pharmacy_id` / `hold_id`
- **DailyUsage** `pharmacy_id` / `date` (IST), TTL
- **Sessions** `session_id`, TTL. Maps the harness session to the verified JWT identity, because hook payloads carry no claims.
