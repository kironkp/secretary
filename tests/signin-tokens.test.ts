// SEC-A013: Google sign-in's tokens encrypted at rest. A row written before
// encryption was on (plaintext, as Kiron's is in production) must keep
// working before and after it is encrypted in place, and encrypting twice
// must change nothing. Through better-auth's own API against the local
// database; no Google.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { symmetricDecrypt } from "better-auth/crypto";
import { db } from "@/lib/db";
import { account, user } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { encryptLegacySignInTokens, looksEncrypted } from "@/lib/auth-tokens";

const U = { id: `test-signin-tokens-${crypto.randomUUID()}`, email: `signin-tokens-${Date.now()}@sec-a013.test` };
const PLAIN = {
  accessToken: "ya29.legacy-access-token-not-a-secret",
  refreshToken: "1//legacy-refresh-token-not-a-secret",
  idToken: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJsZWdhY3kifQ.c2lnbmF0dXJl",
};
let googleRow = "";
let passwordRow = "";

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Sign-in tokens", email: U.email, emailVerified: true });
  const [g] = await db
    .insert(account)
    .values({
      id: crypto.randomUUID(),
      userId: U.id,
      providerId: "google",
      accountId: `g-${Date.now()}`,
      ...PLAIN,
      // Valid for an hour: reading it must not try to refresh at Google.
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: account.id });
  googleRow = g.id;
  const [p] = await db
    .insert(account)
    .values({
      id: crypto.randomUUID(),
      userId: U.id,
      providerId: "credential",
      accountId: U.id,
      password: "scrypt-hash-not-a-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: account.id });
  passwordRow = p.id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const row = async (id: string) => (await db.select().from(account).where(eq(account.id, id)))[0];
const readThroughBetterAuth = () => auth.api.getAccessToken({ body: { providerId: "google", userId: U.id } });

describe("Google sign-in tokens, encrypted at rest", () => {
  it("encryption is on for every new write", async () => {
    expect((await auth.$context).options.account?.encryptOAuthTokens).toBe(true);
  });

  it("a plaintext row from before still works with encryption on (no lockout)", async () => {
    expect((await readThroughBetterAuth()).accessToken).toBe(PLAIN.accessToken);
  });

  it("is encrypted in place, still reads the same, and a second pass changes nothing", async () => {
    expect(await encryptLegacySignInTokens()).toBeGreaterThanOrEqual(1);
    const stored = await row(googleRow);
    const ctx = await auth.$context;
    for (const field of ["accessToken", "refreshToken", "idToken"] as const) {
      expect(stored[field], field).not.toBe(PLAIN[field]);
      expect(looksEncrypted(stored[field]!), field).toBe(true);
      expect(await symmetricDecrypt({ key: ctx.secretConfig, data: stored[field]! }), field).toBe(PLAIN[field]);
    }
    // Read back through better-auth: the same token, so sign-in keeps working.
    expect((await readThroughBetterAuth()).accessToken).toBe(PLAIN.accessToken);
    // Idempotent: already encrypted, so untouched.
    await encryptLegacySignInTokens();
    expect(await row(googleRow)).toEqual(stored);
  });

  it("a password row is never touched", async () => {
    expect((await row(passwordRow)).password).toBe("scrypt-hash-not-a-token");
  });

  it("only values that look encrypted are skipped", () => {
    expect(looksEncrypted(PLAIN.accessToken)).toBe(false);
    expect(looksEncrypted(PLAIN.idToken)).toBe(false);
    expect(looksEncrypted("0a1b2c3d")).toBe(true);
    expect(looksEncrypted("$ba$1$abcd")).toBe(true);
  });
});
