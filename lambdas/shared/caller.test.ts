import { describe, it, expect } from "vitest";
import { resolveCaller, USER_TOKEN_HEADER, type VerifyToken } from "./caller.js";
import { propagatedHeaders, toolName } from "./gateway.js";

const verifyOk = (claims: Record<string, unknown>): VerifyToken => async () => claims;
const verifyBad: VerifyToken = async () => {
  throw new Error("bad signature");
};

describe("resolveCaller", () => {
  it("takes pharmacy and role from the verified token", async () => {
    const c = await resolveCaller({ [USER_TOKEN_HEADER]: "Bearer t" }, verifyOk({ sub: "u1", pharmacy_id: "PH-001", role: "staff" }));
    expect(c).toEqual({ sub: "u1", pharmacy_id: "PH-001", role: "staff" });
  });

  it("fails closed: no token, bad token, missing or malformed claims", async () => {
    await expect(resolveCaller({}, verifyOk({}))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveCaller({ [USER_TOKEN_HEADER]: "t" }, verifyBad)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveCaller({ [USER_TOKEN_HEADER]: "t" }, verifyOk({ sub: "u", role: "staff" }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(resolveCaller({ [USER_TOKEN_HEADER]: "t" }, verifyOk({ sub: "u", pharmacy_id: "PH-001", role: "admin" }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("gateway context helpers", () => {
  it("strips the target prefix from the tool name", () => {
    expect(toolName({ clientContext: { custom: { bedrockAgentCoreToolName: "holds___create_hold" } } })).toBe("create_hold");
    expect(toolName({})).toBe("");
  });

  it("reads propagated headers from an object or a JSON string, lower-casing names", () => {
    expect(propagatedHeaders({ clientContext: { custom: { bedrockAgentCorePropagatedHeaders: { "X-RxGrid-User-Token": "a" } } } })).toEqual({ "x-rxgrid-user-token": "a" });
    expect(propagatedHeaders({ clientContext: { custom: { bedrockAgentCorePropagatedHeaders: '{"X-RxGrid-User-Token":"b"}' } } })).toEqual({ "x-rxgrid-user-token": "b" });
    expect(propagatedHeaders({ clientContext: { custom: { bedrockAgentCorePropagatedHeaders: "not json" } } })).toEqual({});
  });
});
