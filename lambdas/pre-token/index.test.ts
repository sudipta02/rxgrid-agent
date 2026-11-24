import { describe, it, expect } from "vitest";
import { handler, type PreTokenGenV2Event } from "./index.js";

function event(attrs: Record<string, string>, groups?: string[]): PreTokenGenV2Event {
  return {
    triggerSource: "TokenGeneration_Authentication",
    userName: "u",
    request: { userAttributes: attrs, groupConfiguration: { groupsToOverride: groups } },
    response: { claimsAndScopeOverrideDetails: null },
  };
}

describe("pre-token trigger", () => {
  it("adds pharmacy_id and role=staff to both tokens", async () => {
    const out = await handler(event({ "custom:pharmacy_id": "PH-001" }, []));
    const d = out.response.claimsAndScopeOverrideDetails!;
    expect(d.accessTokenGeneration!.claimsToAddOrOverride).toEqual({ pharmacy_id: "PH-001", role: "staff" });
    expect(d.idTokenGeneration!.claimsToAddOrOverride).toEqual({ pharmacy_id: "PH-001", role: "staff" });
  });

  it("grants role=pharmacist only via the pharmacist group", async () => {
    const out = await handler(event({ "custom:pharmacy_id": "PH-003" }, ["pharmacist"]));
    expect(out.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!.claimsToAddOrOverride!.role).toBe(
      "pharmacist",
    );
  });

  it("ignores a role-like user attribute (role comes from groups only)", async () => {
    const out = await handler(event({ "custom:pharmacy_id": "PH-001", "custom:role": "pharmacist" }, []));
    expect(out.response.claimsAndScopeOverrideDetails!.accessTokenGeneration!.claimsToAddOrOverride!.role).toBe(
      "staff",
    );
  });

  it("fails closed without a valid pharmacy_id", async () => {
    await expect(handler(event({}, []))).rejects.toThrow();
    await expect(handler(event({ "custom:pharmacy_id": "PH-001; DROP" }, []))).rejects.toThrow();
  });
});
