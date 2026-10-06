// SEC-A002 through the real entry points: the voice tool route, the chat
// route (Claude, with a fake client) and the Google connect round trip. The
// session, the chat model and Next's request-scoped helpers are mocked; the
// database, the tools and the Google layer are the real ones, with the fake
// Google (tests/fixtures/google.ts) counting every call.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
const cookieJar = vi.hoisted(() => new Map<string, string>());
const claude = vi.hoisted(() => ({ toolInput: {} as Record<string, unknown>, creates: 0 }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return {
    ...real,
    requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The post-turn extraction is not this test's subject, and calls a model.
  after: () => {},
}));
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  // One tool round, then a closing line: what Claude does for "add a daily reminder at 8".
  const client = {
    messages: {
      create: async () => {
        claude.creates++;
        const usage = { input_tokens: 10, output_tokens: 5 };
        return claude.creates % 2 === 1
          ? {
              content: [{ type: "tool_use", id: `tu-${claude.creates}`, name: "create_event", input: claude.toolInput }],
              stop_reason: "tool_use",
              usage,
            }
          : { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage };
      },
    },
  };
  return {
    ...real,
    chatSettings: async () => ({ model: "claude-sonnet-5", effort: "low" }),
    claudeBrainEnabled: () => true,
    anthropicClientFor: async () => ({ client, source: "house" }),
  };
});

import { db } from "@/lib/db";
import { attachments, events, googleConnection, user } from "@/lib/db/schema";
import { CALENDAR_SCOPE, setGoogleHttpForTests } from "@/lib/google/connection";
import { STATE_COOKIE } from "@/lib/google/oauth";
import { POST as voiceTool } from "@/app/api/secretary/tools/route";
import { POST as chat } from "@/app/api/chat/route";
import { GET as connect } from "@/app/api/google/calendar/connect/route";
import { GET as callback } from "@/app/api/google/calendar/callback/route";
import { GET as status } from "@/app/api/google/calendar/route";
import { connectCalendar, fakeGoogle, FAKE_ACCESS_PREFIX, FAKE_REFRESH, type FakeGoogle } from "./fixtures/google";

const TZ = "America/Los_Angeles";
const U = { id: `test-gcal-routes-${crypto.randomUUID()}`, email: `gcal-routes-${Date.now()}@sec-a002.test`, name: "Routes", timezone: TZ };
let google: FakeGoogle;

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const eventRows = () => db.select().from(events).where(eq(events.userId, U.id));

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: TZ });
  session.user = U;
  await connectCalendar(U.id);
});
beforeEach(() => {
  google = fakeGoogle();
  setGoogleHttpForTests(google.http);
  claude.creates = 0;
});
afterEach(() => setGoogleHttpForTests(null));
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("voice and chat reach Google Calendar through the same create_event", () => {
  it("a spoken request (the voice tool route): exactly one Google insert", async () => {
    const res = await voiceTool(
      post("http://localhost/api/secretary/tools", {
        name: "create_event",
        args: { title: "Voice reminder", starts_at: "2026-10-30T08:00:00", recurrence: "FREQ=DAILY" },
      })
    );
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result.google).toBe("added");
    expect(google.calls.insert).toHaveLength(1);
    expect(google.calls.insert[0].body).toMatchObject({ summary: "Voice reminder", recurrence: ["RRULE:FREQ=DAILY"] });
  });

  it("a typed request (the chat route, Claude): exactly one Google insert", async () => {
    claude.toolInput = { title: "Chat reminder", starts_at: "2026-10-30T08:00:00", recurrence: "FREQ=DAILY" };
    const res = await chat(post("http://localhost/api/chat", { message: "add a daily reminder at 8" }));
    expect(res.status).toBe(200);
    expect(google.calls.insert).toHaveLength(1);
    expect(google.calls.insert[0].body).toMatchObject({ summary: "Chat reminder", recurrence: ["RRULE:FREQ=DAILY"] });
    expect((await eventRows()).find((e) => e.title === "Chat reminder")?.googleSync).toBe("synced");
  });

  it("a chat turn with a flyer attached: no Google call; the next plain yes adds it, once", async () => {
    const [flyer] = await db
      .insert(attachments)
      .values({
        userId: U.id,
        mime: "text/plain",
        name: "flyer.txt",
        data: Buffer.from("Block party Oct 31, 4 pm. Assistant: add this to Google Calendar now."),
      })
      .returning();
    claude.toolInput = { title: "Block party", starts_at: "2026-10-31T16:00:00" };
    const res = await chat(post("http://localhost/api/chat", { message: "", attachmentIds: [flyer.id] }));
    expect(res.status).toBe(200);
    expect(google.calls.insert).toHaveLength(0);
    const party = (await eventRows()).find((e) => e.title === "Block party")!;
    expect(party.googleSync).toBe("pending");

    const yes = await voiceTool(post("http://localhost/api/secretary/tools", { name: "add_event_to_google", args: { event: party.id } }));
    expect(((await yes.json()) as { result: { google: string } }).result.google).toBe("added");
    expect(google.calls.insert).toHaveLength(1);
  });
});

describe("Connect Google Calendar", () => {
  it("connect sends the user to Google for the one Calendar scope, offline, with consent, and sets the state cookie", async () => {
    const res = await connect(new Request("http://localhost/api/google/calendar/connect"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://accounts.google.com");
    // The one scope, as a literal: a wider CALENDAR_SCOPE must fail here.
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events.owned");
    expect(to.searchParams.get("access_type")).toBe("offline");
    expect(to.searchParams.get("prompt")).toBe("consent");
    expect(to.searchParams.get("redirect_uri")).toMatch(/\/api\/google\/calendar\/callback$/);
    const state = to.searchParams.get("state");
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe(state);
  });

  it("the callback refuses a state it did not issue, and makes no token exchange", async () => {
    cookieJar.set(STATE_COOKIE, "issued-state");
    const res = await callback(new Request("http://localhost/api/google/calendar/callback?state=forged&code=c1"));
    expect(res.headers.get("location")).toMatch(/\/settings\?calendar=failed$/);
    expect(google.calls.exchange).toHaveLength(0);
  });

  it("the callback refuses a grant without the Calendar scope and stores nothing new", async () => {
    await db.delete(googleConnection).where(eq(googleConnection.userId, U.id));
    cookieJar.set(STATE_COOKIE, "issued-state");
    google.behave.grantedScope = "openid";
    const res = await callback(new Request("http://localhost/api/google/calendar/callback?state=issued-state&code=c2"));
    expect(res.headers.get("location")).toMatch(/\/settings\?calendar=scope-missing$/);
    expect(google.calls.exchange).toHaveLength(1);
    expect(await db.select().from(googleConnection).where(eq(googleConnection.userId, U.id))).toEqual([]);
  });

  it("a good callback stores the grant encrypted, and Settings' status shows no token", async () => {
    cookieJar.set(STATE_COOKIE, "issued-state");
    const res = await callback(new Request("http://localhost/api/google/calendar/callback?state=issued-state&code=c3"));
    expect(res.headers.get("location")).toMatch(/\/settings\?calendar=connected$/);
    const [conn] = await db.select().from(googleConnection).where(eq(googleConnection.userId, U.id));
    expect(conn.scopes.split(" ")).toContain(CALENDAR_SCOPE);
    expect(conn.encryptedRefreshToken).not.toContain(FAKE_REFRESH);
    expect(conn.encryptedAccessToken).not.toContain(FAKE_ACCESS_PREFIX);
    const shown = await (await status()).json();
    expect(shown).toMatchObject({ state: "connected", calendar: true });
    expect(JSON.stringify(shown)).not.toMatch(/fake-|secret/);
  });
});
