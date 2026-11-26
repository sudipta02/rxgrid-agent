/**
 * Who is calling a user-gateway tool, taken from a VERIFIED Cognito access token.
 *
 * The UI backend calls the User Gateway with `Authorization: Bearer <access token>`
 * (checked by the Gateway's JWT authorizer and seen by Cedar) and repeats the same token
 * in the `x-rxgrid-user-token` header, which the target's metadataConfiguration
 * allow-lists for propagation. The Lambda verifies it again here. The token never
 * appears in a tool schema, so the model can neither see nor forge it.
 *
 * Defence in depth: even if a Cedar policy were wrong, a Lambda would still refuse to
 * act for any pharmacy other than the one in the signed token.
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { PHARMACY_ID_PATTERN, type Role } from "./schema.js";
import { ToolError } from "./gateway.js";

export const USER_TOKEN_HEADER = "x-rxgrid-user-token";

export interface Caller {
  sub: string;
  pharmacy_id: string;
  role: Role;
}

export type VerifyToken = (token: string) => Promise<Record<string, unknown>>;

let verifier: VerifyToken | undefined;

/** Lazily built from env: USER_POOL_ID and CLIENT_IDS (comma-separated). */
function defaultVerifier(): VerifyToken {
  if (!verifier) {
    const userPoolId = process.env.USER_POOL_ID;
    const clientIds = (process.env.CLIENT_IDS ?? "").split(",").filter(Boolean);
    if (!userPoolId || clientIds.length === 0) throw new Error("USER_POOL_ID and CLIENT_IDS must be set");
    const v = CognitoJwtVerifier.create({ userPoolId, tokenUse: "access", clientId: clientIds });
    verifier = (t) => v.verify(t) as unknown as Promise<Record<string, unknown>>;
  }
  return verifier;
}

export async function resolveCaller(
  headers: Record<string, string>,
  verify: VerifyToken = defaultVerifier(),
): Promise<Caller> {
  const token = headers[USER_TOKEN_HEADER];
  if (!token) throw new ToolError("UNAUTHENTICATED", "No user token was propagated to this tool.");
  let claims: Record<string, unknown>;
  try {
    claims = await verify(token.replace(/^Bearer\s+/i, ""));
  } catch {
    throw new ToolError("UNAUTHENTICATED", "The user token is invalid or expired.");
  }
  const pharmacy_id = claims.pharmacy_id;
  const role = claims.role;
  if (typeof pharmacy_id !== "string" || !PHARMACY_ID_PATTERN.test(pharmacy_id)) {
    throw new ToolError("UNAUTHENTICATED", "The user token has no pharmacy assignment.");
  }
  if (role !== "staff" && role !== "pharmacist") {
    throw new ToolError("UNAUTHENTICATED", "The user token has no valid role.");
  }
  return { sub: String(claims.sub), pharmacy_id, role };
}

/** Reject any tool input that names a different requesting pharmacy than the token. */
export function assertOwnPharmacy(caller: Caller, inputPharmacyId: unknown): void {
  if (inputPharmacyId !== caller.pharmacy_id) {
    throw new ToolError(
      "FORBIDDEN_TENANT",
      "You can only act for your own pharmacy. The pharmacy comes from your sign-in, not from the request.",
    );
  }
}
