/**
 * Create the demo/stress-test users in the RxGrid Cognito user pool.
 *
 * Each user gets a random 24-character password. Credentials are written to
 * stress-test/.test-users.json, which is git-ignored, and are never printed.
 * Emails use example.com (reserved; nothing is delivered) and no invitation is sent.
 *
 * Re-running is safe: existing users get a fresh password and their group is re-applied.
 *
 * Usage (after `cdk deploy RxGrid-Auth`):
 *   USER_POOL_ID=ap-southeast-2_xxxx AWS_PROFILE=rxgrid npx tsx seed/seed-users.ts
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { PHARMACY_ID_PATTERN, type Role } from "../lambdas/shared/schema.js";

export interface TestUser {
  key: string;
  email: string;
  pharmacy_id: string;
  role: Role;
}

/** Who the stress test signs in as. See stress-test/prompts.json for which case uses whom. */
export const TEST_USERS: TestUser[] = [
  { key: "ph001_staff", email: "ph001.staff@example.com", pharmacy_id: "PH-001", role: "staff" },
  { key: "ph001_pharmacist", email: "ph001.pharmacist@example.com", pharmacy_id: "PH-001", role: "pharmacist" },
  { key: "ph003_staff", email: "ph003.staff@example.com", pharmacy_id: "PH-003", role: "staff" },
  { key: "ph004_pharmacist", email: "ph004.pharmacist@example.com", pharmacy_id: "PH-004", role: "pharmacist" },
];

/** Random password meeting the pool policy (lower, upper, digit, symbol, 12+ chars). */
function randomPassword(): string {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}

async function main() {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) throw new Error("Set USER_POOL_ID (CloudFormation output RxGrid-Auth.UserPoolId)");
  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });

  const creds: Record<string, { username: string; password: string; pharmacy_id: string; role: Role }> = {};
  for (const u of TEST_USERS) {
    if (!PHARMACY_ID_PATTERN.test(u.pharmacy_id)) throw new Error(`bad pharmacy_id for ${u.key}`);
    const attrs = [
      { Name: "email", Value: u.email },
      { Name: "email_verified", Value: "true" },
      { Name: "custom:pharmacy_id", Value: u.pharmacy_id },
    ];
    try {
      await client.send(
        new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: u.email, UserAttributes: attrs, MessageAction: "SUPPRESS" }),
      );
    } catch (e) {
      if (!(e instanceof UsernameExistsException)) throw e;
      await client.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: u.email, UserAttributes: attrs }));
    }
    const password = randomPassword();
    await client.send(
      new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: u.email, Password: password, Permanent: true }),
    );
    const [join_, leave] = u.role === "pharmacist" ? ["pharmacist", "staff"] : ["staff", "pharmacist"];
    await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: u.email, GroupName: join_ }));
    await client
      .send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: u.email, GroupName: leave }))
      .catch(() => undefined); // not a member: fine
    creds[u.key] = { username: u.email, password, pharmacy_id: u.pharmacy_id, role: u.role };
    console.log(`  ${u.key}: ${u.pharmacy_id} / ${u.role}`);
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), "../stress-test/.test-users.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(creds, null, 2), { mode: 0o600 });
  console.log(`Credentials written to stress-test/.test-users.json (git-ignored).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
