// Signs a test user in once and saves the cookie jar for every spec.
//
// The app requires a verified email (lib/auth.ts, requireEmailVerification:
// true), so a user created through the API cannot sign in until the flag is
// flipped. There is no test-only bypass in the app and there should not be one:
// the sign-in the tests exercise is the real sign-in.
//
// Order: create the user through better-auth's own HTTP route so the password
// is hashed the way the app hashes it, flip email_verified in Postgres, then
// sign in through the actual form so the saved state came from the real path.
import { webkit, type FullConfig } from "@playwright/test";
import { Client } from "pg";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TEST_USER = {
  email: "e2e@secretary.test",
  password: "e2e-password-not-a-secret",
  name: "E2E Tester",
};

const STATE_PATH = "e2e/.auth/user.json";

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

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";

  // Idempotent: a re-run must not trip the unique email constraint. The cascade
  // takes the user's sessions, accounts and any rows a previous run created.
  await withDb(async (c) => {
    await c.query('DELETE FROM "user" WHERE email = $1', [TEST_USER.email]);
  });

  // Better Auth rejects a state-changing POST with no Origin
  // (MISSING_OR_NULL_ORIGIN) — a browser always sends one, Node's fetch does
  // not. Send the app's own origin so the CSRF check passes without weakening
  // it. Found by the first CI run of this harness, 2026-09-17.
  const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseURL },
    body: JSON.stringify(TEST_USER),
  });
  if (!signUp.ok && signUp.status !== 422) {
    throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }

  const verified = await withDb(async (c) => {
    const r = await c.query(
      'UPDATE "user" SET email_verified = true WHERE email = $1 RETURNING id',
      [TEST_USER.email]
    );
    return r.rows[0]?.id as string | undefined;
  });
  if (!verified) throw new Error("test user was not created; sign-up route did not persist a row");

  // Sign in through the form, not the API, so the saved cookies come from the
  // path a person takes — and in WebKit, the same engine the specs run in.
  // Cookies saved from Chromium did not authenticate the WebKit contexts
  // (every signed-in spec bounced to /sign-in); keeping one engine end to end
  // removes the whole class of problem. Found by CI run 4, 2026-09-17.
  const browser = await webkit.launch();
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto("/sign-in");
    await page.getByLabel(/email/i).fill(TEST_USER.email);
    await page.getByLabel(/password/i).fill(TEST_USER.password);
    // Exact: the page also carries "Sign in with a passkey", and a loose
    // regex matches both.
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20_000 });
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const state = await page.context().storageState({ path: STATE_PATH });
    // Fail here, loudly, rather than letting every signed-in spec bounce to
    // /sign-in and look like an app bug.
    if (state.cookies.length === 0) {
      throw new Error("signed in but captured no cookies; storage state would be useless");
    }
  } finally {
    await browser.close();
  }
}
