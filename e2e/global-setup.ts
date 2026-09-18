// Prepares a signed-in session for every spec, without driving a browser.
//
// The app requires a verified email (lib/auth.ts, requireEmailVerification:
// true) and there is no test-only bypass in the app — there should not be one,
// because the sign-in the specs rely on is the real sign-in.
//
// Why HTTP and not a browser: signing in through the form and saving the jar
// worked in Chromium and produced ZERO cookies in WebKit (CI run 5), which is
// the engine the iPhone profile runs on. Rather than keep guessing at engine
// cookie policy on http://localhost, take the Set-Cookie the server actually
// issues and write the storage state directly. Deterministic, engine-neutral,
// and several seconds faster per run.
import type { FullConfig } from "@playwright/test";
import { Client } from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STORAGE_STATE } from "./paths";

export const TEST_USER = {
  email: "e2e@secretary.test",
  password: "e2e-password-not-a-secret",
  name: "E2E Tester",
};

type StateCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; e2e needs the test database");
  const host = new URL(url).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const client = new Client({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** One raw Set-Cookie line into the shape Playwright's storageState wants. */
function parseSetCookie(raw: string, host: string, overHttp: boolean): StateCookie | null {
  const [pair, ...attrParts] = raw.split(";");
  const eq = pair.indexOf("=");
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name || !value) return null;

  const attrs = new Map<string, string>();
  for (const part of attrParts) {
    const i = part.indexOf("=");
    const k = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    attrs.set(k, i === -1 ? "" : part.slice(i + 1).trim());
  }

  const maxAge = attrs.has("max-age") ? Number(attrs.get("max-age")) : undefined;
  const expiresAttr = attrs.get("expires");
  const expires =
    maxAge !== undefined && Number.isFinite(maxAge)
      ? Math.floor(Date.now() / 1000) + maxAge
      : expiresAttr
        ? Math.floor(new Date(expiresAttr).getTime() / 1000)
        : -1;

  const sameSiteRaw = (attrs.get("samesite") ?? "lax").toLowerCase();
  const sameSite = sameSiteRaw === "strict" ? "Strict" : sameSiteRaw === "none" ? "None" : "Lax";

  return {
    name,
    value,
    domain: host,
    path: attrs.get("path") || "/",
    expires: Number.isFinite(expires) ? expires : -1,
    httpOnly: attrs.has("httponly"),
    // A Secure cookie is never sent over http, so the specs would silently run
    // signed out. The test origin is plain http on loopback; keep the flag off
    // there. This relaxes nothing in the app — only in the saved jar.
    secure: overHttp ? false : attrs.has("secure"),
    sameSite,
  };
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";
  const url = new URL(baseURL);
  const overHttp = url.protocol === "http:";

  // Idempotent: a re-run must not trip the unique email constraint. The cascade
  // takes the user's sessions and accounts with it.
  await withDb(async (c) => {
    await c.query('DELETE FROM "user" WHERE email = $1', [TEST_USER.email]);
  });

  // Better Auth refuses a state-changing POST with no Origin
  // (MISSING_OR_NULL_ORIGIN): a browser always sends one, Node's fetch does
  // not. Sending the app's own origin satisfies the check without weakening it.
  const headers = { "Content-Type": "application/json", Origin: baseURL };

  const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify(TEST_USER),
  });
  if (!signUp.ok && signUp.status !== 422) {
    throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }

  const userId = await withDb(async (c) => {
    const r = await c.query(
      'UPDATE "user" SET email_verified = true WHERE email = $1 RETURNING id',
      [TEST_USER.email]
    );
    return r.rows[0]?.id as string | undefined;
  });
  if (!userId) throw new Error("test user was not created; the sign-up route persisted no row");

  const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
  });
  if (!signIn.ok) {
    throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  }

  const raw = signIn.headers.getSetCookie();
  const cookies = raw
    .map((line) => parseSetCookie(line, url.hostname, overHttp))
    .filter((c): c is StateCookie => c !== null);

  if (cookies.length === 0) {
    throw new Error(
      `sign-in returned 200 but set no cookies (${raw.length} Set-Cookie headers). ` +
        "Every signed-in spec would run signed out."
    );
  }

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));
  console.log(
    `[e2e] signed in as ${TEST_USER.email}: ` +
      `${cookies.map((c) => c.name).join(", ")} -> ${STORAGE_STATE}`
  );
}
