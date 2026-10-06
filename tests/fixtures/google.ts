// A fake Google for SEC-A002: every call is counted, nothing leaves the
// machine. Install it with setGoogleHttpForTests(fake.http); under vitest the
// real client refuses to run without it (lib/google/connection.ts).
import {
  CALENDAR_SCOPE,
  GoogleAuthError,
  GoogleHttpError,
  saveConnection,
  type CalendarEventBody,
  type GoogleHttp,
} from "@/lib/google/connection";

/** Tokens the fake hands out; a test greps results and rows for these to prove none leaked. */
export const FAKE_REFRESH = "fake-refresh-secret-7f3a";
export const FAKE_ACCESS_PREFIX = "fake-access-secret-";

export type FakeGoogle = ReturnType<typeof fakeGoogle>;

export function fakeGoogle() {
  const calls = {
    exchange: [] as { code: string; redirectUri: string }[],
    refresh: [] as string[],
    revoke: [] as string[],
    insert: [] as { token: string; body: CalendarEventBody }[],
    patch: [] as { token: string; eventId: string; body: CalendarEventBody }[],
    delete: [] as { token: string; eventId: string }[],
  };
  /** Change these mid-test to make Google misbehave. */
  const behave = {
    refresh: "ok" as "ok" | "invalid_grant",
    grantedScope: CALENDAR_SCOPE,
    /** HTTP status the next calls of each kind fail with, one entry per failing call. */
    insertFails: [] as number[],
    patchFails: [] as number[],
    deleteFails: [] as number[],
  };
  let issued = 0;
  const fail = (queue: number[]) => {
    const status = queue.shift();
    if (status) throw new GoogleHttpError(status, status === 401 ? "Invalid Credentials" : `Backend Error ${status}`);
  };
  const http: GoogleHttp = {
    async exchangeCode(code, redirectUri) {
      calls.exchange.push({ code, redirectUri });
      return { accessToken: `${FAKE_ACCESS_PREFIX}${++issued}`, expiresIn: 3600, refreshToken: FAKE_REFRESH, scope: behave.grantedScope };
    },
    async refresh(refreshToken) {
      calls.refresh.push(refreshToken);
      if (behave.refresh === "invalid_grant") throw new GoogleAuthError("invalid_grant: Token has been expired or revoked.");
      return { accessToken: `${FAKE_ACCESS_PREFIX}${++issued}`, expiresIn: 3600 };
    },
    async revoke(token) {
      calls.revoke.push(token);
    },
    async insertEvent(token, body) {
      calls.insert.push({ token, body });
      fail(behave.insertFails);
      return { id: `gcal-${calls.insert.length}` };
    },
    async patchEvent(token, eventId, body) {
      calls.patch.push({ token, eventId, body });
      fail(behave.patchFails);
    },
    async deleteEvent(token, eventId) {
      calls.delete.push({ token, eventId });
      fail(behave.deleteFails);
    },
  };
  return { http, calls, behave };
}

/** A user who connected Google Calendar a moment ago (as the callback would store it). */
export async function connectCalendar(userId: string, opts: { accessExpired?: boolean } = {}): Promise<void> {
  await saveConnection(userId, {
    accessToken: `${FAKE_ACCESS_PREFIX}0`,
    expiresIn: opts.accessExpired ? -60 : 3600,
    refreshToken: FAKE_REFRESH,
    scope: `openid ${CALENDAR_SCOPE}`,
  });
}
