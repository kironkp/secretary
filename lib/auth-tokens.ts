// Google sign-in's tokens, encrypted at rest (SEC-A013). better-auth keeps an
// OAuth sign-in's access, refresh and ID tokens in the `account` table; with
// account.encryptOAuthTokens on (lib/auth.ts) it encrypts every new write
// (XChaCha20-Poly1305, keyed by BETTER_AUTH_SECRET) and decrypts on read,
// passing through any value that does not look encrypted. So turning it on
// locks nobody out, but the rows written before stay readable plaintext:
// this encrypts those in place, once, at boot (instrumentation.ts). It is
// idempotent: a value that already looks encrypted is left alone.
import { eq, ne } from "drizzle-orm";
import { symmetricEncrypt } from "better-auth/crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { account } from "@/lib/db/schema";

/** better-auth's own test (oauth2/utils.mjs isLikelyEncrypted): an envelope, or even-length hex. */
export const looksEncrypted = (v: string): boolean =>
  v.startsWith("$ba$") || (v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v));

const TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

/** Encrypt every plaintext sign-in token in place; returns how many accounts changed. Never logs a token. */
export async function encryptLegacySignInTokens(): Promise<number> {
  const ctx = await auth.$context;
  const rows = await db
    .select({ id: account.id, accessToken: account.accessToken, refreshToken: account.refreshToken, idToken: account.idToken })
    .from(account)
    // Password sign-in rows carry a hash, never a token.
    .where(ne(account.providerId, "credential"));
  let changed = 0;
  for (const row of rows) {
    const update: Partial<Record<(typeof TOKEN_FIELDS)[number], string>> = {};
    for (const field of TOKEN_FIELDS) {
      const value = row[field];
      if (value && !looksEncrypted(value)) update[field] = await symmetricEncrypt({ key: ctx.secretConfig, data: value });
    }
    if (Object.keys(update).length === 0) continue;
    await db.update(account).set(update).where(eq(account.id, row.id));
    changed++;
  }
  return changed;
}
