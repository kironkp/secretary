// The consent round trip for the user's Google grant (lib/google/connection.ts):
// Settings → /api/google/calendar/connect → Google → /api/google/calendar/callback.
// Offline access and a consent prompt every time, so Google always hands
// back a refresh token; a state cookie ties the callback to the browser that
// started it.
import { randomBytes, timingSafeEqual } from "node:crypto";

export const STATE_COOKIE = "google_oauth_state";
export const CALLBACK_PATH = "/api/google/calendar/callback";

/** The callback URL Google redirects to; it must be registered in the Google Cloud console exactly. */
export function redirectUri(requestUrl: string): string {
  const base = process.env.BETTER_AUTH_URL ?? new URL(requestUrl).origin;
  return `${base.replace(/\/$/, "")}${CALLBACK_PATH}`;
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function sameState(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Google's consent page for `scopes`, as the user `email` when known. */
export function consentUrl(opts: { scopes: string[]; redirectUri: string; state: string; email?: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    // A later grant (Gmail) keeps the earlier ones on the same token.
    include_granted_scopes: "true",
    state: opts.state,
    ...(opts.email ? { login_hint: opts.email } : {}),
  }).toString();
  return url.toString();
}
