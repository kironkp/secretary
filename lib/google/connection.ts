// The user's own Google account, connected from Settings (SEC-A002,
// 2026-10-06). Apart from Google sign-in on purpose: better-auth's Google
// provider sets access_type and prompt for every sign-in, and a sign-in
// rewrites its `account` row; this grant asks once for offline access to the
// scopes a feature needs, and nothing but Connect and Disconnect touches it.
//
// Tokens are encrypted at rest (lib/crypto.ts) and leave this module only as
// the Authorization header of a call to Google: never in a log line, a tool
// result, a Settings payload or a model's context. When Google refuses the
// refresh token (revoked, or the 7-day expiry of an app still in Testing),
// the connection turns "disconnected", the user is told once that day by
// push, and every caller gets one plain sentence to say.
//
// Every call to Google goes through `GoogleHttp`, which tests replace with a
// fake (setGoogleHttpForTests). Under vitest there is no default: a test
// that forgets the fake fails instead of reaching Google.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { googleConnection } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { alertOnce } from "@/lib/spend-guard";

/** Events on calendars the user owns, the primary among them; nothing shared with them (developers.google.com/workspace/calendar/api/auth). */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

export const NOT_CONNECTED_LINE = "Google Calendar isn't connected. Connect it in Settings.";
export const DISCONNECTED_LINE = "Google Calendar is disconnected. Reconnect it in Settings.";
export const MISSING_SCOPE_LINE =
  "Google Calendar access wasn't granted. Reconnect it in Settings and allow calendar access.";

export type TokenSet = {
  accessToken: string;
  /** Seconds. */
  expiresIn: number;
  refreshToken?: string;
  /** Space-separated, as Google sends it. */
  scope?: string;
};

/** Google refused the grant itself: invalid_grant, a revoked or expired refresh token. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** A Google API call that failed with an HTTP status; the message is Google's, never a token. */
export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GoogleHttpError";
  }
}

/** Why a Google call could not be made, with the one sentence the assistant says. */
export class GoogleUnavailable extends Error {
  constructor(
    readonly kind: "not-connected" | "disconnected" | "missing-scope",
    message: string
  ) {
    super(message);
    this.name = "GoogleUnavailable";
  }
}

export type CalendarEventBody = Record<string, unknown>;

export type GoogleHttp = {
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  insertEvent(accessToken: string, body: CalendarEventBody): Promise<{ id: string }>;
  patchEvent(accessToken: string, eventId: string, body: CalendarEventBody): Promise<void>;
  /** A 404 or 410 (already gone) is success. */
  deleteEvent(accessToken: string, eventId: string): Promise<void>;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set");
  return { clientId, clientSecret };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    const detail = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    if (code === "invalid_grant" || code === "unauthorized_client") throw new GoogleAuthError(`${code}${detail}`);
    throw new GoogleHttpError(res.status, `${code}${detail}`);
  }
  return {
    accessToken: String(json.access_token),
    expiresIn: Number(json.expires_in ?? 3600),
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

async function apiRequest(method: string, url: string, accessToken: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res;
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new GoogleHttpError(res.status, json.error?.message ?? `HTTP ${res.status}`);
}

const httpGoogle: GoogleHttp = {
  exchangeCode: (code, redirectUri) => {
    const { clientId, clientSecret } = clientCredentials();
    return tokenRequest({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
  },
  refresh: (refreshToken) => {
    const { clientId, clientSecret } = clientCredentials();
    return tokenRequest({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    });
  },
  revoke: async (token) => {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
  },
  insertEvent: async (accessToken, body) => {
    const res = await apiRequest("POST", EVENTS_URL, accessToken, body);
    const json = (await res.json()) as { id: string };
    return { id: json.id };
  },
  patchEvent: async (accessToken, eventId, body) => {
    await apiRequest("PATCH", `${EVENTS_URL}/${encodeURIComponent(eventId)}`, accessToken, body);
  },
  deleteEvent: async (accessToken, eventId) => {
    try {
      await apiRequest("DELETE", `${EVENTS_URL}/${encodeURIComponent(eventId)}`, accessToken);
    } catch (e) {
      if (e instanceof GoogleHttpError && (e.status === 404 || e.status === 410)) return;
      throw e;
    }
  },
};

let testHttp: GoogleHttp | null = null;

/** Tests only: every Google call goes to `fake` (null puts the default back). */
export function setGoogleHttpForTests(fake: GoogleHttp | null): void {
  testHttp = fake;
}

export function googleHttp(): GoogleHttp {
  if (testHttp) return testHttp;
  if (process.env.VITEST) throw new Error("no Google under vitest: setGoogleHttpForTests(fake)");
  return httpGoogle;
}

// --------------------------------------------------------------------------
// The stored grant
// --------------------------------------------------------------------------

export type ConnectionStatus =
  | { state: "not-connected" }
  | { state: "connected"; calendar: boolean; connectedAt: string }
  | { state: "disconnected"; reason: string | null; calendar: boolean };

/** What Settings shows; no token in it. */
export async function connectionStatus(userId: string): Promise<ConnectionStatus> {
  const [row] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
  if (!row) return { state: "not-connected" };
  const calendar = row.scopes.split(" ").includes(CALENDAR_SCOPE);
  if (row.status === "disconnected") return { state: "disconnected", reason: row.lastError, calendar };
  return { state: "connected", calendar, connectedAt: row.connectedAt.toISOString() };
}

/**
 * Store what Google handed back after consent. Scopes add up (a later grant
 * for Gmail keeps Calendar); a grant without a refresh token keeps the one
 * already stored, and with neither there is nothing to keep.
 */
export async function saveConnection(userId: string, tokens: TokenSet): Promise<void> {
  const [existing] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
  const refresh = tokens.refreshToken
    ? encryptSecret(tokens.refreshToken)
    : existing?.encryptedRefreshToken;
  if (!refresh) throw new GoogleAuthError("Google sent no refresh token");
  const scopes = [...new Set([...(existing?.scopes.split(" ") ?? []), ...(tokens.scope?.split(" ") ?? [])])]
    .filter(Boolean)
    .join(" ");
  const now = new Date();
  const values = {
    scopes,
    encryptedRefreshToken: refresh,
    encryptedAccessToken: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
    status: "connected" as const,
    lastError: null,
    connectedAt: now,
    updatedAt: now,
  };
  await db
    .insert(googleConnection)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: googleConnection.userId, set: values });
}

/** Forget the grant here and ask Google to revoke it; the revoke is best effort. */
export async function disconnectGoogle(userId: string): Promise<void> {
  const [row] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
  if (!row) return;
  await db.delete(googleConnection).where(eq(googleConnection.userId, userId));
  try {
    await googleHttp().revoke(decryptSecret(row.encryptedRefreshToken));
  } catch (e) {
    console.warn("google: revoke failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Google refused the grant: say so once today, and refuse every call until Reconnect. */
async function markDisconnected(userId: string, reason: string): Promise<void> {
  await db
    .update(googleConnection)
    .set({ status: "disconnected", lastError: reason, encryptedAccessToken: null, updatedAt: new Date() })
    .where(and(eq(googleConnection.userId, userId), eq(googleConnection.status, "connected")));
  await alertOnce(
    userId,
    "google-disconnected",
    "Google Calendar is disconnected",
    "New events stay in Secretary until you reconnect it in Settings.",
    "google"
  );
}

/** An access token for `scope`, refreshed when it has under a minute left. */
async function accessToken(userId: string, scope: string, forceRefresh = false): Promise<string> {
  const [row] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
  if (!row) throw new GoogleUnavailable("not-connected", NOT_CONNECTED_LINE);
  if (row.status === "disconnected") throw new GoogleUnavailable("disconnected", DISCONNECTED_LINE);
  if (!row.scopes.split(" ").includes(scope)) throw new GoogleUnavailable("missing-scope", MISSING_SCOPE_LINE);
  const fresh =
    !forceRefresh &&
    row.encryptedAccessToken &&
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() - Date.now() > 60_000;
  if (fresh) return decryptSecret(row.encryptedAccessToken!);

  let tokens: TokenSet;
  try {
    tokens = await googleHttp().refresh(decryptSecret(row.encryptedRefreshToken));
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      await markDisconnected(userId, e.message);
      throw new GoogleUnavailable("disconnected", DISCONNECTED_LINE);
    }
    throw e;
  }
  await db
    .update(googleConnection)
    .set({
      encryptedAccessToken: encryptSecret(tokens.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      // Google may rotate it; most refreshes send none.
      ...(tokens.refreshToken ? { encryptedRefreshToken: encryptSecret(tokens.refreshToken) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(googleConnection.userId, userId));
  return tokens.accessToken;
}

/**
 * Run `call` with an access token for `scope`. A 401 from Google gets one
 * fresh token and one retry; a second 401 means the grant is gone.
 */
export async function withGoogle<T>(
  userId: string,
  scope: string,
  call: (http: GoogleHttp, token: string) => Promise<T>
): Promise<T> {
  const http = googleHttp();
  try {
    return await call(http, await accessToken(userId, scope));
  } catch (e) {
    if (!(e instanceof GoogleHttpError) || e.status !== 401) throw e;
  }
  try {
    return await call(http, await accessToken(userId, scope, true));
  } catch (e) {
    if (e instanceof GoogleHttpError && e.status === 401) {
      await markDisconnected(userId, "Google refused the access token twice");
      throw new GoogleUnavailable("disconnected", DISCONNECTED_LINE);
    }
    throw e;
  }
}

/** True when the user has a Calendar grant that is not known to be dead. */
export async function calendarConnected(userId: string): Promise<boolean> {
  const status = await connectionStatus(userId);
  return status.state === "connected" && status.calendar;
}
