/**
 * Cognito pre-token-generation trigger (event version V2_0).
 *
 * Copies the user's tenant and role into top-level claims on BOTH the access token and
 * the ID token:
 *   pharmacy_id  <- custom:pharmacy_id  (admin-set; app clients cannot write it)
 *   role         <- "pharmacist" if the user is in the `pharmacist` group, else "staff"
 *
 * The access token is what the harness and Gateway JWT authorizers verify. AgentCore
 * Policy exposes its claims to Cedar as principal tags (principal.getTag("role")).
 *
 * Fail closed: a user without a valid pharmacy_id gets no token at all.
 */
import { PHARMACY_ID_PATTERN, type Role } from "../shared/schema.js";

/** Minimal shape of the V2 event; only the fields we read or write. */
export interface PreTokenGenV2Event {
  triggerSource: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration: { groupsToOverride?: string[] };
  };
  response: {
    claimsAndScopeOverrideDetails?: {
      idTokenGeneration?: { claimsToAddOrOverride?: Record<string, string> };
      accessTokenGeneration?: { claimsToAddOrOverride?: Record<string, string> };
    } | null;
  };
}

export const PHARMACIST_GROUP = "pharmacist";

export function resolveClaims(event: PreTokenGenV2Event): { pharmacy_id: string; role: Role } {
  const pharmacyId = event.request.userAttributes["custom:pharmacy_id"];
  if (!pharmacyId || !PHARMACY_ID_PATTERN.test(pharmacyId)) {
    // Throwing makes Cognito reject the sign-in, so no token without a tenant is issued.
    throw new Error("User has no valid pharmacy assignment");
  }
  const groups = event.request.groupConfiguration.groupsToOverride ?? [];
  const role: Role = groups.includes(PHARMACIST_GROUP) ? "pharmacist" : "staff";
  return { pharmacy_id: pharmacyId, role };
}

export const handler = async (event: PreTokenGenV2Event): Promise<PreTokenGenV2Event> => {
  const claims = resolveClaims(event);
  event.response.claimsAndScopeOverrideDetails = {
    idTokenGeneration: { claimsToAddOrOverride: claims },
    accessTokenGeneration: { claimsToAddOrOverride: claims },
  };
  // Log the decision only, never the token or other user attributes.
  console.log(JSON.stringify({ triggerSource: event.triggerSource, ...claims }));
  return event;
};
