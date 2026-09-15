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

export const auth = betterAuth({
  baseURL,
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
