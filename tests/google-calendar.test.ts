// SEC-A002: events by voice and chat reach the user's Google Calendar, one
// way, through the existing event tools. Every Google call goes to a fake
// (tests/fixtures/google.ts) and is counted; nothing here can reach Google.
// The process zone is pinned to UTC, as on Heroku, so a time read in the
// server's zone instead of the user's shows up here as it did in production.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, events, googleConnection, pushLog, user } from "@/lib/db/schema";
import { googleEventBody } from "@/lib/google/calendar";
import { CALENDAR_SCOPE, DISCONNECTED_LINE, NOT_CONNECTED_LINE, setGoogleHttpForTests } from "@/lib/google/connection";
import { applyExtraction } from "@/lib/secretary/extraction";
import { describeRecurrence, normalizeRecurrence } from "@/lib/secretary/rrule";
import { executeTool, liveTurnContext, type ToolContext } from "@/lib/secretary/tools";
import { parseInTz, wallTimeInTz } from "@/lib/time";
import { connectCalendar, fakeGoogle, FAKE_ACCESS_PREFIX, FAKE_REFRESH, type FakeGoogle } from "./fixtures/google";

const TZ = "America/Los_Angeles";
const users: string[] = [];
let google: FakeGoogle;

async function newUser(): Promise<string> {
  const id = `test-gcal-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Calendar Tester", email: `${id}@sec-a002.test`, timezone: TZ });
  return id;
}

const voice = (userId: string): ToolContext => liveTurnContext({ userId, timezone: TZ, attachmentCount: 0 });
const flyerTurn = (userId: string): ToolContext => liveTurnContext({ userId, timezone: TZ, attachmentCount: 1 });

async function create(ctx: ToolContext, args: Record<string, unknown>) {
  const out = await executeTool(ctx, "create_event", args);
  return out.result as Record<string, unknown>;
}

const row = async (id: string) => (await db.select().from(events).where(eq(events.id, id)))[0];

beforeEach(() => {
  google = fakeGoogle();
  setGoogleHttpForTests(google.http);
});
afterEach(() => setGoogleHttpForTests(null));
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the grant asks for exactly one Calendar scope", () => {
  it("events on calendars the user owns, nothing wider", () => {
    expect(CALENDAR_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events.owned");
  });
});

describe("time: the user's wall clock, not the server's", () => {
  it("an offset-less time is read in the user's zone on both sides of the Nov 1, 2026 DST change", () => {
    expect(parseInTz("2026-10-30T08:00:00", TZ)?.toISOString()).toBe("2026-10-30T15:00:00.000Z"); // PDT
    expect(parseInTz("2026-11-02T08:00:00", TZ)?.toISOString()).toBe("2026-11-02T16:00:00.000Z"); // PST
    expect(parseInTz("2026-10-30T08:00:00-07:00", TZ)?.toISOString()).toBe("2026-10-30T15:00:00.000Z");
    expect(parseInTz("2026-10-30T08:00:00Z", TZ)?.toISOString()).toBe("2026-10-30T08:00:00.000Z");
    expect(wallTimeInTz(new Date("2026-11-02T16:00:00Z"), TZ)).toBe("2026-11-02T08:00:00");
    expect(parseInTz("not a date", TZ)).toBeNull();
  });

  it("recurrence is checked and said back in plain words", () => {
    expect(normalizeRecurrence("FREQ=DAILY")).toEqual(["RRULE:FREQ=DAILY"]);
    expect(normalizeRecurrence("rrule:freq=weekly;byday=mo,tu,we,th,fr")).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
    expect(normalizeRecurrence(undefined)).toEqual([]);
    expect(() => normalizeRecurrence("FREQ=HOURLY")).toThrow(/FREQ/);
    expect(() => normalizeRecurrence("FREQ=DAILY;BYSETPOS=1")).toThrow(/BYSETPOS/);
    expect(describeRecurrence(["RRULE:FREQ=DAILY"])).toBe("every day");
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"])).toBe("every weekday");
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10"])).toBe(
      "every 2 weeks on Monday and Wednesday, 10 times"
    );
  });
});

describe("a plain voice or chat turn writes Google Calendar at once", () => {
  it("a daily 8:00 reminder: one insert, wall-clock time plus the zone (never an offset), RRULE, popup, read back", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), {
      title: "Daily Reminder",
      starts_at: "2026-10-30T08:00:00",
      recurrence: "FREQ=DAILY",
      reminders: ["2026-10-30T07:55:00"],
    });

    expect(google.calls.insert).toHaveLength(1);
    const body = google.calls.insert[0].body as Record<string, { dateTime: string; timeZone: string }> & {
      recurrence: string[];
      reminders: unknown;
      summary: string;
    };
    expect(body.summary).toBe("Daily Reminder");
    // 8:00 in Los Angeles, as Google keeps it across Nov 1: no offset in it.
    expect(body.start).toEqual({ dateTime: "2026-10-30T08:00:00", timeZone: TZ });
    expect(body.end).toEqual({ dateTime: "2026-10-30T08:30:00", timeZone: TZ });
    expect(body.recurrence).toEqual(["RRULE:FREQ=DAILY"]);
    expect(body.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 5 }] });

    const stored = await row(String(out.event_id));
    expect(stored.startsAt.toISOString()).toBe("2026-10-30T15:00:00.000Z");
    expect(stored).toMatchObject({ googleEventId: "gcal-1", googleSync: "synced", recurrence: ["RRULE:FREQ=DAILY"], timeZone: TZ });
    expect(out.google).toBe("added");
    expect(out.read_back).toBe("Daily Reminder, every day at 8:00 AM, starting Fri, Oct 30. It's on your Google Calendar.");
    expect(out.delivery).toBe("push notification to the user's phone at each time");
  });

  it("the same 8:00 after the change is 8:00 too: an event made in PST carries the same wall time", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), { title: "Daily Reminder (winter)", starts_at: "2026-11-02T08:00:00", recurrence: "FREQ=DAILY" });
    expect(google.calls.insert).toHaveLength(1);
    expect((google.calls.insert[0].body as { start: unknown }).start).toEqual({ dateTime: "2026-11-02T08:00:00", timeZone: TZ });
    expect((await row(String(out.event_id))).startsAt.toISOString()).toBe("2026-11-02T16:00:00.000Z");
  });

  it("a one-off: one insert, no recurrence, read back with its day and time", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), { title: "Dentist", starts_at: "2026-10-20T14:30:00", ends_at: "2026-10-20T15:30:00" });
    expect(google.calls.insert).toHaveLength(1);
    expect(google.calls.insert[0].body).toMatchObject({
      start: { dateTime: "2026-10-20T14:30:00", timeZone: TZ },
      end: { dateTime: "2026-10-20T15:30:00", timeZone: TZ },
      recurrence: [],
      reminders: { useDefault: true },
    });
    expect(out.read_back).toBe("Dentist, Tue, Oct 20 at 2:30 PM. It's on your Google Calendar.");
  });

  it("undo deletes the Google copy by the id it was given, once, and the app row with it", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const made = await create(voice(userId), { title: "Undo me", starts_at: "2026-10-21T09:00:00" });
    const undo = await executeTool(voice(userId), "delete_event", { event: made.event_id });
    expect(undo.result).toEqual({ deleted: "Undo me", removed_from_google: true });
    expect(google.calls.delete).toEqual([{ token: expect.any(String), eventId: "gcal-1" }]);
    expect(await row(String(made.event_id))).toBeUndefined();

    const again = await executeTool(voice(userId), "delete_event", { event: made.event_id });
    expect(again.result).toEqual({ error: `No event matching "${made.event_id}"` });
    expect(google.calls.delete).toHaveLength(1);
  });

  it("a Google refusal on delete keeps the event and says so", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const made = await create(voice(userId), { title: "Stays", starts_at: "2026-10-22T09:00:00" });
    google.behave.deleteFails.push(500);
    const out = await executeTool(voice(userId), "delete_event", { event: made.event_id });
    expect(String((out.result as { error: string }).error)).toMatch(/^Not removed: Google Calendar refused/);
    expect(google.calls.delete).toHaveLength(1);
    expect(await row(String(made.event_id))).toBeDefined();
  });

  it("update_event patches the Google copy by its stored id; a refusal is said, not swallowed", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const made = await create(voice(userId), { title: "Standup", starts_at: "2026-10-23T09:00:00" });
    const moved = await executeTool(voice(userId), "update_event", {
      event: made.event_id,
      starts_at: "2026-10-23T09:30:00",
      recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    });
    expect(google.calls.patch).toHaveLength(1);
    expect(google.calls.patch[0].eventId).toBe("gcal-1");
    expect(google.calls.patch[0].body).toMatchObject({
      start: { dateTime: "2026-10-23T09:30:00", timeZone: TZ },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
    });
    expect(moved.result).toMatchObject({ google: "updated", repeats: "every weekday" });

    google.behave.patchFails.push(503);
    const failed = await executeTool(voice(userId), "update_event", { event: made.event_id, title: "Standup (moved)" });
    expect(google.calls.patch).toHaveLength(2);
    expect(failed.result).toMatchObject({ google: "failed", google_problem: expect.stringMatching(/refused/) });
    expect((await row(String(made.event_id))).googleSync).toBe("failed");
  });

  it("a 401 gets one fresh token and one retry", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    google.behave.insertFails.push(401);
    const out = await create(voice(userId), { title: "Retry", starts_at: "2026-10-24T09:00:00" });
    expect(out.google).toBe("added");
    expect(google.calls.insert).toHaveLength(2);
    expect(google.calls.refresh).toHaveLength(1);
  });

  it("no token ever reaches a tool result, a row or the Settings status", async () => {
    const userId = await newUser();
    await connectCalendar(userId, { accessExpired: true });
    const out = await executeTool(voice(userId), "create_event", { title: "Leak check", starts_at: "2026-10-25T09:00:00" });
    expect(google.calls.refresh).toHaveLength(1);
    const visible = JSON.stringify(out);
    expect(visible).not.toContain(FAKE_REFRESH);
    expect(visible).not.toContain(FAKE_ACCESS_PREFIX);
    const [conn] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
    expect(JSON.stringify(conn)).not.toContain(FAKE_REFRESH);
    expect(JSON.stringify(conn)).not.toContain(FAKE_ACCESS_PREFIX);
  });
});

describe("a repeating event starts at its next occurrence, in the user's zone (fake clock)", () => {
  // "Add a daily reminder at 8" carries whatever date the model picked; the
  // server moves a start that already passed to the next 8:00 local.
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("at 07:00 PDT, 8:00 today stays today, and yesterday's 8:00 becomes today's", async () => {
    at("2026-10-06T14:00:00Z"); // Tue 07:00 PDT
    const userId = await newUser();
    await connectCalendar(userId);
    const today = await create(voice(userId), { title: "Vitamins", starts_at: "2026-10-06T08:00:00", recurrence: "FREQ=DAILY" });
    const fromYesterday = await create(voice(userId), { title: "Water the plants", starts_at: "2026-10-05T08:00:00", recurrence: "FREQ=DAILY" });
    expect((await row(String(today.event_id))).startsAt.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect((await row(String(fromYesterday.event_id))).startsAt.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(google.calls.insert).toHaveLength(2);
    expect(google.calls.insert.map((c) => (c.body as { start: unknown }).start)).toEqual([
      { dateTime: "2026-10-06T08:00:00", timeZone: TZ },
      { dateTime: "2026-10-06T08:00:00", timeZone: TZ },
    ]);
    expect(fromYesterday.read_back).toBe("Water the plants, every day at 8:00 AM, starting Tue, Oct 6. It's on your Google Calendar.");
  });

  it("at 09:00 PDT, today's 8:00 has passed: it starts tomorrow, reminders moved with it", async () => {
    at("2026-10-06T16:00:00Z"); // Tue 09:00 PDT
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), {
      title: "Daily Reminder",
      starts_at: "2026-10-06T08:00:00",
      recurrence: "FREQ=DAILY",
      reminders: ["2026-10-06T07:55:00"],
    });
    const stored = await row(String(out.event_id));
    expect(stored.startsAt.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(stored.reminders).toEqual(["2026-10-07T14:55:00.000Z"]);
    expect(google.calls.insert).toHaveLength(1);
    expect(google.calls.insert[0].body).toMatchObject({
      start: { dateTime: "2026-10-07T08:00:00", timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 5 }] },
    });
  });

  it("Oct 31 at 09:00 PDT: the next 8:00 is Nov 1, 8:00 PST, sent to Google as wall time plus the zone", async () => {
    at("2026-10-31T16:00:00Z"); // Sat 09:00 PDT
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), { title: "Daily Reminder", starts_at: "2026-10-31T08:00:00", recurrence: "FREQ=DAILY" });
    expect((await row(String(out.event_id))).startsAt.toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect(google.calls.insert).toHaveLength(1);
    expect((google.calls.insert[0].body as { start: unknown }).start).toEqual({ dateTime: "2026-11-01T08:00:00", timeZone: TZ });
  });

  it("weekdays, said on a Friday after 8: it starts Monday at 8", async () => {
    at("2026-10-09T16:00:00Z"); // Fri 09:00 PDT
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), {
      title: "Standup",
      starts_at: "2026-10-09T08:00:00",
      recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    });
    expect((await row(String(out.event_id))).startsAt.toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(google.calls.insert).toHaveLength(1);
    expect((google.calls.insert[0].body as { start: unknown }).start).toEqual({ dateTime: "2026-10-12T08:00:00", timeZone: TZ });
    expect(out.read_back).toBe("Standup, every weekday at 8:00 AM, starting Mon, Oct 12. It's on your Google Calendar.");
  });

  it("weekly with no BYDAY keeps the start's weekday: a past Monday rolls to the next Monday", async () => {
    at("2026-10-07T16:00:00Z"); // Wed 09:00 PDT (sec rev probe P3)
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(voice(userId), { title: "Trash out", starts_at: "2026-10-05T08:00:00", recurrence: "FREQ=WEEKLY" });
    expect((await row(String(out.event_id))).startsAt.toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(google.calls.insert).toHaveLength(1);
    expect((google.calls.insert[0].body as { start: unknown }).start).toEqual({ dateTime: "2026-10-12T08:00:00", timeZone: TZ });
    expect(out.read_back).toBe("Trash out, every week at 8:00 AM, starting Mon, Oct 12. It's on your Google Calendar.");
  });

  it("a monthly or yearly start in the past is refused with the reason; nothing is made", async () => {
    at("2026-10-06T16:00:00Z");
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await executeTool(voice(userId), "create_event", { title: "Rent", starts_at: "2026-10-01T09:00:00", recurrence: "FREQ=MONTHLY" });
    expect(String((out.result as { error: string }).error)).toMatch(/first occurrence/);
    expect(google.calls.insert).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.userId, userId))).toEqual([]);
  });

  it("update_event that makes a past event repeat moves it to the next occurrence, and Google gets that", async () => {
    at("2026-10-06T16:00:00Z"); // Tue 09:00 PDT
    const userId = await newUser();
    await connectCalendar(userId);
    const made = await create(voice(userId), { title: "Stretch", starts_at: "2026-10-06T08:00:00" });
    expect(made.read_back).toBe("Stretch, Tue, Oct 6 at 8:00 AM. It's on your Google Calendar. That time has already passed.");
    await executeTool(voice(userId), "update_event", { event: made.event_id, recurrence: "FREQ=DAILY" });
    expect((await row(String(made.event_id))).startsAt.toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(google.calls.patch).toHaveLength(1);
    expect((google.calls.patch[0].body as { start: unknown }).start).toEqual({ dateTime: "2026-10-07T08:00:00", timeZone: TZ });
  });
});

describe("a dead or missing grant is said plainly, and pushed once a day", () => {
  it("invalid_grant on refresh: the event stays in the app, the user hears the sentence, the connection turns disconnected, one push", async () => {
    const userId = await newUser();
    await connectCalendar(userId, { accessExpired: true });
    google.behave.refresh = "invalid_grant";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await create(voice(userId), { title: "After expiry", starts_at: "2026-10-26T09:00:00" });
      expect(first.google).toBe("disconnected");
      expect(first.read_back).toBe(`After expiry, Mon, Oct 26 at 9:00 AM. It's saved in Secretary only. ${DISCONNECTED_LINE}`);
      expect(google.calls.refresh).toHaveLength(1);
      expect(google.calls.insert).toHaveLength(0);
      expect((await row(String(first.event_id))).googleSync).toBe("failed");
      const [conn] = await db.select().from(googleConnection).where(eq(googleConnection.userId, userId));
      expect(conn.status).toBe("disconnected");

      // Known dead: no second refresh, no second push.
      const second = await create(voice(userId), { title: "Still dead", starts_at: "2026-10-27T09:00:00" });
      expect(second.google).toBe("disconnected");
      expect(google.calls.refresh).toHaveLength(1);
      const pushes = await db
        .select()
        .from(pushLog)
        .where(and(eq(pushLog.userId, userId), like(pushLog.key, "google-disconnected:%")));
      expect(pushes).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("never connected: saved in the app, told how to connect, no Google call", async () => {
    const userId = await newUser();
    const out = await create(voice(userId), { title: "No Google", starts_at: "2026-10-26T10:00:00" });
    expect(out.google).toBe("not-connected");
    expect(out.read_back).toBe(`No Google, Mon, Oct 26 at 10:00 AM. It's saved in Secretary only. ${NOT_CONNECTED_LINE}`);
    expect(google.calls.insert).toHaveLength(0);
    expect(google.calls.refresh).toHaveLength(0);
  });
});

describe("only the user's own plain words write Google Calendar", () => {
  it("a turn with an attachment keeps the event in the app and asks; only a later plain yes adds it, once", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create(flyerTurn(userId), { title: "Block party", starts_at: "2026-10-31T16:00:00" });
    expect(out.google).toBe("ask");
    expect(out.read_back).toBe("Block party, Sat, Oct 31 at 4:00 PM. It's saved in Secretary. Add it to your Google Calendar?");
    expect((await row(String(out.event_id))).googleSync).toBe("pending");
    expect(google.calls.insert).toHaveLength(0);

    // The flyer's own text asking for it, in the same turn, is refused.
    const injected = await executeTool(flyerTurn(userId), "add_event_to_google", { event: out.event_id });
    expect(String((injected.result as { error: string }).error)).toMatch(/plain message/);
    expect(google.calls.insert).toHaveLength(0);

    const yes = await executeTool(voice(userId), "add_event_to_google", { event: out.event_id });
    expect(yes.result).toMatchObject({ google: "added" });
    expect(google.calls.insert).toHaveLength(1);
    const twice = await executeTool(voice(userId), "add_event_to_google", { event: out.event_id });
    expect(twice.result).toMatchObject({ note: "Already on Google Calendar." });
    expect(google.calls.insert).toHaveLength(1);
  });

  it("from an attachment turn, a synced event can be neither changed nor deleted on Google", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const made = await create(voice(userId), { title: "Real meeting", starts_at: "2026-10-28T11:00:00" });
    const moved = await executeTool(flyerTurn(userId), "update_event", { event: made.event_id, starts_at: "2026-10-28T03:00:00" });
    const gone = await executeTool(flyerTurn(userId), "delete_event", { event: made.event_id });
    expect(String((moved.result as { error: string }).error)).toMatch(/plain message/);
    expect(String((gone.result as { error: string }).error)).toMatch(/plain message/);
    expect(google.calls.patch).toHaveLength(0);
    expect(google.calls.delete).toHaveLength(0);
    expect((await row(String(made.event_id))).startsAt.toISOString()).toBe("2026-10-28T18:00:00.000Z");
  });

  it("a caller with no live turn (an understanding answer, a script) stays in the app", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const out = await create({ userId, timezone: TZ }, { title: "From an answer", starts_at: "2026-10-29T09:00:00" });
    expect(out.google).toBe("app-only");
    expect((await row(String(out.event_id))).googleSync).toBeNull();
    expect(google.calls.insert).toHaveLength(0);
  });

  it("the extractor's inferred events never reach Google, read the user's zone, and don't double a spoken event", async () => {
    const userId = await newUser();
    await connectCalendar(userId);
    const [conv] = await db.insert(conversations).values({ userId, mode: "voice" }).returning();
    // The voice session made it; the extractor then reads the same words.
    await create(liveTurnContext({ userId, timezone: TZ, conversationId: conv.id, attachmentCount: 0 }), {
      title: "Daily Reminder",
      starts_at: "2026-10-30T08:00:00",
    });
    const summary = await applyExtraction(userId, conv.id, {
      tasks: [],
      events: [
        { title: "Daily Reminder", starts_at: "2026-10-30T08:00:00", ends_at: null, location: null, project: null },
        { title: "Coffee with Ana", starts_at: "2026-10-31T10:00:00", ends_at: null, location: null, project: null },
      ],
      status_updates: [],
      facts: [],
      mentions: [],
      ambiguities: [],
    });
    expect(summary.createdEvents).toBe(1);
    expect(google.calls.insert).toHaveLength(1); // the spoken one only
    const coffee = (await db.select().from(events).where(eq(events.userId, userId))).find((e) => e.title === "Coffee with Ana")!;
    expect(coffee.startsAt.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(coffee.googleSync).toBeNull();
  });
});

describe("the Google event body", () => {
  it("reminders become minutes before each occurrence; Google's limits are kept", () => {
    const startsAt = new Date("2026-10-30T15:00:00Z");
    const body = googleEventBody({
      id: "e",
      userId: "u",
      projectId: null,
      title: "T",
      startsAt,
      endsAt: null,
      location: "Here",
      notes: "Notes",
      reminders: [
        "2026-10-30T14:50:00.000Z",
        "2026-10-30T14:50:00.000Z",
        "2026-10-30T16:00:00.000Z", // after the start: dropped
        "2026-09-01T15:00:00.000Z", // past four weeks: dropped
      ],
      recurrence: [],
      timeZone: TZ,
      googleEventId: null,
      googleSync: null,
      source: "spoken",
      conversationId: null,
      messageId: null,
      createdAt: startsAt,
    });
    expect(body).toMatchObject({
      location: "Here",
      description: "Notes",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    });
  });
});
