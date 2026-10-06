import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { passkey } from "@better-auth/passkey";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sendResetPasswordEmail, sendVerificationEmail } from "@/lib/email";

// Google/Apple are dormant code paths: they activate when their env keys appear
// in .env.local. Apple additionally needs an https deploy (Apple rejects plain
// http://localhost return URLs), so it stays off until then.
const socialProviders = {
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {}),
  ...(process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
    ? {
        apple: {
          clientId: process.env.APPLE_CLIENT_ID,
          clientSecret: process.env.APPLE_CLIENT_SECRET,
        },
      }
    : {}),
};

// Extra origins allowed to hit the auth API (e.g. the Tailscale HTTPS
// hostname when accessing dev from a phone). Comma-separated URLs.
const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Auth base URL: static when BETTER_AUTH_URL is set (Heroku); otherwise
// resolved per request from the Host header so OAuth callbacks return to
// whichever origin the user is on (localhost, the ts.net proxy, a cloudflare
// tunnel) instead of hardcoding localhost. Hosts are allowlisted from
// TRUSTED_ORIGINS; localhost:* also covers the sim harness's second server.
const baseURL = process.env.BETTER_AUTH_URL ?? {
  allowedHosts: ["localhost:*", ...trustedOrigins.map((u) => new URL(u).host)],
  fallback: "http://localhost:3000",
};

/**
 * "Remember me" (SEC-A012, Kiron: "add remember me functionality"). A
 * remembered sign-in lasts 60 days and slides: each use after a day renews
 * it to 60 days from then. Not remembered (the box unticked, email and
 * password only), better-auth sets a cookie with no expiry, so it ends when
 * the browser or the home-screen app is closed, and the session itself
 * lasts at most a day and is not renewed. Google and passkey sign-in cannot
 * be told otherwise and are always remembered. The cookies' secure,
 * httpOnly and sameSite attributes are better-auth's defaults, unchanged.
 */
export const SESSION_EXPIRES_IN = 60 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE = 24 * 60 * 60;

export const auth = betterAuth({
  baseURL,
  session: { expiresIn: SESSION_EXPIRES_IN, updateAge: SESSION_UPDATE_AGE },
  secret: process.env.BETTER_AUTH_SECRET,
  ...(trustedOrigins.length ? { trustedOrigins } : {}),
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, url);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail(user.email, url);
    },
  },
  user: {
    additionalFields: {
      timezone: {
        type: "string",
        required: false,
        defaultValue: "UTC",
        input: true,
      },
    },
  },
  socialProviders,
  plugins: [passkey(), nextCookies()], // nextCookies must stay last
});

export const socialProvidersEnabled = {
  google: "google" in socialProviders,
  apple: "apple" in socialProviders,
};

export type Session = typeof auth.$Infer.Session;
