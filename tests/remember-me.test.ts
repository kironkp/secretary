// SEC-A012, Kiron: "add remember me functionality". Through better-auth's
// own API against the local database, no browser: a remembered sign-in is a
// 60-day cookie and session that slides on use; an unremembered one is a
// cookie with no expiry (it ends with the browser or the app) and a session
// of at most a day that is not renewed. Email is a no-op here.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/email", () => ({
  sendVerificationEmail: async () => undefined,
  sendResetPasswordEmail: async () => undefined,
}));

import { db } from "@/lib/db";
import { session, user } from "@/lib/db/schema";
import { auth, SESSION_EXPIRES_IN, SESSION_UPDATE_AGE } from "@/lib/auth";

const EMAIL = `remember-${Date.now()}@sec-a012.test`;
const PASSWORD = "correct horse battery staple 42";
const DAY = 86_400_000;
let userId = "";

beforeAll(async () => {
  await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "Remember" } });
  const [u] = await db.update(user).set({ emailVerified: true }).where(eq(user.email, EMAIL)).returning({ id: user.id });
  userId = u.id;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, userId));
});

/** Sign in with the box ticked or not; the Set-Cookie lines and the stored session. */
async function signIn(rememberMe: boolean) {
  const res = (await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD, rememberMe }, asResponse: true })) as Response;
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  const token = cookies.find((c) => /session_token=/.test(c))!;
  const value = decodeURIComponent(token.split(";")[0].split("=").slice(1).join("="));
  const [row] = await db.select().from(session).where(eq(session.token, value.split(".")[0]));
  return { cookies, token, cookiePair: token.split(";")[0], row };
}

const near = (at: Date, expected: number) => Math.abs(at.getTime() - expected) < 60_000;

describe("remember me", () => {
  it("is 60 days, renewed at most daily", () => {
    expect(SESSION_EXPIRES_IN).toBe(60 * 24 * 60 * 60);
    expect(SESSION_UPDATE_AGE).toBe(24 * 60 * 60);
  });

  it("ticked: a 60-day cookie and a 60-day session; secure-by-default attributes kept", async () => {
    const { token, cookies, row } = await signIn(true);
    expect(token).toMatch(/Max-Age=5184000/i);
    expect(token).toMatch(/HttpOnly/i);
    expect(token).toMatch(/SameSite=Lax/i);
    expect(cookies.some((c) => /dont_remember/.test(c))).toBe(false);
    expect(near(row.expiresAt, Date.now() + 60 * DAY)).toBe(true);
  });

  it("unticked: a cookie with no expiry (ends with the browser or app) and a session of a day", async () => {
    const { token, cookies, row } = await signIn(false);
    expect(token).not.toMatch(/Max-Age|Expires/i);
    expect(token).toMatch(/HttpOnly/i);
    expect(token).toMatch(/SameSite=Lax/i);
    expect(cookies.some((c) => /dont_remember=/.test(c))).toBe(true);
    expect(near(row.expiresAt, Date.now() + 1 * DAY)).toBe(true);
  });

  it("ticked and used after a day: the session slides to 60 days from now", async () => {
    const { cookiePair, row } = await signIn(true);
    // As if signed in three days ago: 57 days left.
    await db.update(session).set({ expiresAt: new Date(Date.now() + 57 * DAY) }).where(eq(session.id, row.id));
    const got = await auth.api.getSession({ headers: new Headers({ cookie: cookiePair }) });
    expect(got?.session.id).toBe(row.id);
    const [after] = await db.select().from(session).where(eq(session.id, row.id));
    expect(near(after.expiresAt, Date.now() + 60 * DAY)).toBe(true);
  });

  it("ticked and used within the day: not rewritten (renewal is at most daily)", async () => {
    const { cookiePair, row } = await signIn(true);
    const [before] = await db.select().from(session).where(eq(session.id, row.id));
    await auth.api.getSession({ headers: new Headers({ cookie: cookiePair }) });
    const [after] = await db.select().from(session).where(eq(session.id, row.id));
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it("unticked and used: never extended", async () => {
    const { cookies, cookiePair, row } = await signIn(false);
    const dontRemember = cookies.find((c) => /dont_remember=/.test(c))!.split(";")[0];
    await db.update(session).set({ expiresAt: new Date(Date.now() + 2 * 3_600_000) }).where(eq(session.id, row.id));
    const got = await auth.api.getSession({ headers: new Headers({ cookie: `${cookiePair}; ${dontRemember}` }) });
    expect(got?.session.id).toBe(row.id);
    const [after] = await db.select().from(session).where(eq(session.id, row.id));
    expect(near(after.expiresAt, Date.now() + 2 * 3_600_000)).toBe(true);
  });
});
