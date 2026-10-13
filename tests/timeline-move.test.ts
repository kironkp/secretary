// SEC-A009: a move on the timeline is the same operation as saying it. The
// route hands every move to update_task / update_event through executeTool
// in a live turn, so a Google-synced event is patched on Google, a later due
// date counts as postponed, reminders move with the item, a start can't pass
// the due date, and a repeating event is not dragged. Against the local
// database; Google is a fake, the session is mocked, no model is called.
process.env.TZ = "UTC";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const U = vi.hoisted(() => ({
  id: `test-timeline-move-${crypto.randomUUID()}`,
  email: `timeline-move-${Date.now()}@sec-a009.test`,
  tz: "America/Los_Angeles",
}));
const google = vi.hoisted(() => ({ patches: [] as { id: string; startsAt: Date }[], fail: false }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  requireSession: async () => ({ id: U.id, email: U.email, name: "Timeline Mover", timezone: U.tz }),
}));
vi.mock("@/lib/google/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/calendar")>()),
  patchGoogleEvent: async (_userId: string, googleId: string, event: { startsAt: Date }) => {
    if (google.fail) throw new Error("rateLimitExceeded");
    google.patches.push({ id: googleId, startsAt: event.startsAt });
  },
  insertGoogleEvent: async () => {
    throw new Error("the timeline never makes a new Google event");
  },
}));

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, events, expectations, projects, tasks, user } from "@/lib/db/schema";
import { POST as move } from "@/app/api/timeline/move/route";
import { POST as retry } from "@/app/api/timeline/google-retry/route";
import { POST as undo } from "@/app/api/timeline/undo/route";
import { openUndo, sealUndo } from "@/lib/timeline-undo";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { openAIVoiceToolDefs } from "@/lib/secretary/tool-schemas";
import { shiftDays } from "@/lib/timeline";

const ids: Record<string, string> = {};
const OTHER = { id: `test-timeline-other-${crypto.randomUUID()}`, email: `timeline-other-${Date.now()}@sec-a009.test` };

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Timeline Mover", email: U.email, timezone: U.tz },
    { id: OTHER.id, name: "Someone else", email: OTHER.email, timezone: U.tz },
  ]);
  const [album] = await db.insert(projects).values({ userId: U.id, name: "Album" }).returning();
  ids.album = album.id;
  const [cover, stems, passport, theirs] = await db
    .insert(tasks)
    .values([
      {
        userId: U.id,
        projectId: album.id,
        title: "Design the album cover",
        status: "todo" as const,
        source: "spoken" as const,
        startAt: new Date("2026-10-08T16:00:00Z"),
        dueAt: new Date("2026-10-15T00:00:00Z"),
        reminders: ["2026-10-14T16:00:00.000Z"],
      },
      { userId: U.id, projectId: album.id, title: "Send the stems", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-10-09T19:00:00Z") },
      { userId: U.id, title: "Renew the passport", status: "inbox" as const, source: "spoken" as const },
      { userId: OTHER.id, title: "Not yours", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-10-09T19:00:00Z") },
    ])
    .returning();
  Object.assign(ids, { cover: cover.id, stems: stems.id, passport: passport.id, theirs: theirs.id });
  const [session, weekly] = await db
    .insert(events)
    .values([
      {
        userId: U.id,
        projectId: album.id,
        title: "Mixing session",
        startsAt: new Date("2026-10-10T17:00:00Z"),
        endsAt: new Date("2026-10-10T20:00:00Z"),
        googleEventId: "g-mixing-session",
        googleSync: "synced",
        reminders: ["2026-10-10T16:00:00.000Z"],
      },
      {
        userId: U.id,
        title: "Weekly band practice",
        startsAt: new Date("2026-10-07T02:00:00Z"),
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
      },
    ])
    .returning();
  Object.assign(ids, { session: session.id, weekly: weekly.id });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});
beforeEach(() => {
  google.patches = [];
  google.fail = false;
});

const post = (handler: (req: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://localhost/api/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const eventRow = async (id: string) => (await db.select().from(events).where(eq(events.id, id)))[0];

describe("a drag is update_task: the dates, the postponed count, the reminders", () => {
  it("dragging a bar 2 days later moves start, due and its reminder, and counts as postponed", async () => {
    const before = await taskRow(ids.cover);
    const days = 2;
    const res = await post(move, {
      kind: "task",
      id: ids.cover,
      due_at: shiftDays(before.dueAt!.toISOString(), days, U.tz),
      start_at: shiftDays(before.startAt!.toISOString(), days, U.tz),
      reminders: before.reminders.map((r) => shiftDays(r, days, U.tz)),
    });
    expect(res.status).toBe(200);
    const after = await taskRow(ids.cover);
    expect(after.dueAt!.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(after.startAt!.toISOString()).toBe("2026-10-10T16:00:00.000Z");
    expect(after.reminders).toEqual(["2026-10-16T16:00:00.000Z"]);
    // The tool's own bookkeeping: a raw write to the row would not count it.
    expect(after.postponedCount).toBe(before.postponedCount + 1);
  });

  it("dragging the left edge sets only the start; the due date and the postponed count stay", async () => {
    const before = await taskRow(ids.cover);
    expect((await post(move, { kind: "task", id: ids.cover, start_at: "2026-10-05T16:00:00.000Z" })).status).toBe(200);
    const after = await taskRow(ids.cover);
    expect(after.startAt!.toISOString()).toBe("2026-10-05T16:00:00.000Z");
    expect(after.dueAt).toEqual(before.dueAt);
    expect(after.postponedCount).toBe(before.postponedCount);
  });

  it("a start on the due date itself is allowed (sec rev G5)", async () => {
    const res = await post(move, { kind: "task", id: ids.stems, start_at: "2026-10-09T19:00:00.000Z" });
    expect(res.status).toBe(200);
    expect((await taskRow(ids.stems)).startAt!.toISOString()).toBe("2026-10-09T19:00:00.000Z");
    // One millisecond later is after it: refused, and the start stays.
    expect((await post(move, { kind: "task", id: ids.stems, start_at: "2026-10-09T19:00:00.001Z" })).status).toBe(422);
    expect((await taskRow(ids.stems)).startAt!.toISOString()).toBe("2026-10-09T19:00:00.000Z");
    await post(move, { kind: "task", id: ids.stems, start_at: null });
  });

  it("a start after the due date is refused, and nothing changes", async () => {
    const before = await taskRow(ids.stems);
    const res = await post(move, { kind: "task", id: ids.stems, start_at: "2026-10-20T16:00:00.000Z" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { result: { error: string } }).result.error).toMatch(/start can't be after the due date/);
    expect(await taskRow(ids.stems)).toEqual(before);
  });

  it("dropping a No-date task on a day gives it that date; Undo puts it back in the tray", async () => {
    const res = await post(move, { kind: "task", id: ids.passport, due_at: "2026-10-13T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect((await taskRow(ids.passport)).dueAt!.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    const { undo: token } = (await res.json()) as { undo: string };
    expect((await post(undo, { token })).status).toBe(200);
    expect((await taskRow(ids.passport)).dueAt).toBeNull();
  });

  it('a null due date (what "take the date off it" sends) clears it through update_task', async () => {
    await post(move, { kind: "task", id: ids.passport, due_at: "2026-10-14T00:00:00.000Z" });
    expect((await post(move, { kind: "task", id: ids.passport, due_at: null })).status).toBe(200);
    expect((await taskRow(ids.passport)).dueAt).toBeNull();
  });

  it("someone else's task is not found, and stays as it was", async () => {
    const before = await taskRow(ids.theirs);
    const res = await post(move, { kind: "task", id: ids.theirs, due_at: "2026-10-30T19:00:00.000Z" });
    expect(res.status).toBe(422);
    expect(await taskRow(ids.theirs)).toEqual(before);
  });
});

describe("a drag is update_event: Google is patched in the same move", () => {
  it("moving a Google-synced event patches Google once with the new start", async () => {
    const res = await post(move, {
      kind: "event",
      id: ids.session,
      starts_at: "2026-10-11T17:00:00.000Z",
      ends_at: "2026-10-11T20:00:00.000Z",
      reminders: ["2026-10-11T16:00:00.000Z"],
    });
    expect(res.status).toBe(200);
    expect(google.patches).toEqual([{ id: "g-mixing-session", startsAt: new Date("2026-10-11T17:00:00.000Z") }]);
    const row = await eventRow(ids.session);
    expect(row.startsAt.toISOString()).toBe("2026-10-11T17:00:00.000Z");
    expect(row.reminders).toEqual(["2026-10-11T16:00:00.000Z"]);
    expect(row.googleSync).toBe("synced");
  });

  it("when Google refuses, the move is kept and says so; Retry sends it again", async () => {
    google.fail = true;
    const res = await post(move, { kind: "event", id: ids.session, starts_at: "2026-10-12T17:00:00.000Z", ends_at: "2026-10-12T20:00:00.000Z" });
    const body = (await res.json()) as { result: { google_problem?: string } };
    expect(res.status).toBe(200);
    expect(body.result.google_problem).toMatch(/Google Calendar refused it/);
    expect((await eventRow(ids.session)).startsAt.toISOString()).toBe("2026-10-12T17:00:00.000Z");
    expect((await eventRow(ids.session)).googleSync).toBe("failed");

    google.fail = false;
    const again = (await (await post(retry, { id: ids.session })).json()) as { result: { google: string } };
    expect(again.result.google).toBe("added");
    expect(google.patches).toEqual([{ id: "g-mixing-session", startsAt: new Date("2026-10-12T17:00:00.000Z") }]);
    expect((await eventRow(ids.session)).googleSync).toBe("synced");
  });

  it("a repeating event is not moved by dragging, and Google is not touched", async () => {
    const before = await eventRow(ids.weekly);
    const res = await post(move, { kind: "event", id: ids.weekly, starts_at: "2026-10-08T02:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(await eventRow(ids.weekly)).toEqual(before);
    expect(google.patches).toEqual([]);
  });
});

describe("Undo means it never happened (sec plan): a restore, not another move", () => {
  let mix = "";
  let party = "";
  let expectation = "";
  let olderCheckin = "";
  beforeAll(async () => {
    const [t] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        projectId: ids.album,
        title: "Mix the B-side",
        status: "todo" as const,
        source: "spoken" as const,
        dueAt: new Date("2026-10-20T00:00:00Z"),
        reminders: ["2026-10-19T16:00:00.000Z"],
        postponedCount: 2,
        updatedAt: new Date("2026-10-01T12:00:00Z"),
      })
      .returning();
    mix = t.id;
    const [x] = await db
      .insert(expectations)
      .values({ userId: U.id, taskId: mix, commitment: "Send the B-side mix", expectedUpdateBy: new Date("2026-10-18T00:00:00Z") })
      .returning();
    expectation = x.id;
    const [c] = await db.insert(checkins).values({ userId: U.id, taskId: mix, type: "user_update", note: "Started the mix" }).returning();
    olderCheckin = c.id;
    const [e] = await db
      .insert(events)
      .values({
        userId: U.id,
        title: "Listening party",
        startsAt: new Date("2026-10-16T02:00:00Z"),
        endsAt: new Date("2026-10-16T05:00:00Z"),
        googleEventId: "g-listening-party",
        googleSync: "synced",
        reminders: ["2026-10-16T01:00:00.000Z"],
      })
      .returning();
    party = e.id;
  });

  const ticketOf = async (res: Response) => ((await res.json()) as { undo: string }).undo;
  const mixState = async () => {
    const row = await taskRow(mix);
    const notes = (await db.select().from(checkins).where(eq(checkins.taskId, mix))).map((c) => c.id).sort();
    const [x] = await db.select().from(expectations).where(eq(expectations.id, expectation));
    return {
      dueAt: row.dueAt?.toISOString(),
      startAt: row.startAt?.toISOString() ?? null,
      reminders: row.reminders,
      postponedCount: row.postponedCount,
      updatedAt: row.updatedAt.toISOString(),
      checkins: notes,
      expectation: { status: x.status, clearedAt: x.clearedAt },
    };
  };

  it("drag later → Undo: the postponed count, its check-in and the cleared expectation are all as they were", async () => {
    const before = await mixState();
    expect(before.postponedCount).toBe(2);
    expect(before.expectation.status).toBe("open");
    const res = await post(move, {
      kind: "task",
      id: mix,
      due_at: shiftDays("2026-10-20T00:00:00.000Z", 3, U.tz),
      reminders: [shiftDays("2026-10-19T16:00:00.000Z", 3, U.tz)],
    });
    expect(res.status).toBe(200);
    const token = await ticketOf(res);
    // The move did what a postponement does.
    const moved = await mixState();
    expect(moved.postponedCount).toBe(3);
    expect(moved.checkins).toHaveLength(2);
    expect(moved.expectation.status).toBe("cleared");

    expect((await post(undo, { token })).status).toBe(200);
    expect(await mixState()).toEqual(before);
    expect((await mixState()).checkins).toEqual([olderCheckin]);
  });

  it("drag earlier → Undo: moving it back later is not counted as a postponement", async () => {
    const before = await mixState();
    const res = await post(move, { kind: "task", id: mix, due_at: shiftDays("2026-10-20T00:00:00.000Z", -2, U.tz) });
    expect((await post(undo, { token: await ticketOf(res) })).status).toBe(200);
    expect(await mixState()).toEqual(before);
  });

  it("a Google-synced event: drag → Undo patches Google exactly once more, back to the original times", async () => {
    const res = await post(move, {
      kind: "event",
      id: party,
      starts_at: "2026-10-18T02:00:00.000Z",
      ends_at: "2026-10-18T05:00:00.000Z",
      reminders: ["2026-10-18T01:00:00.000Z"],
    });
    expect(res.status).toBe(200);
    expect(google.patches).toHaveLength(1);
    const token = await ticketOf(res);

    expect((await post(undo, { token })).status).toBe(200);
    expect(google.patches).toEqual([
      { id: "g-listening-party", startsAt: new Date("2026-10-18T02:00:00.000Z") },
      { id: "g-listening-party", startsAt: new Date("2026-10-16T02:00:00.000Z") },
    ]);
    const row = await eventRow(party);
    expect(row.startsAt.toISOString()).toBe("2026-10-16T02:00:00.000Z");
    expect(row.endsAt!.toISOString()).toBe("2026-10-16T05:00:00.000Z");
    expect(row.reminders).toEqual(["2026-10-16T01:00:00.000Z"]);
    expect(row.googleSync).toBe("synced");
  });

  it("an Undo after the item moved again restores nothing", async () => {
    const first = await post(move, { kind: "task", id: mix, due_at: "2026-10-22T00:00:00.000Z" });
    const stale = await ticketOf(first);
    const second = await post(move, { kind: "task", id: mix, due_at: "2026-10-24T00:00:00.000Z" });
    const afterSecond = await mixState();
    const res = await post(undo, { token: stale });
    expect(res.status).toBe(409);
    expect(await mixState()).toEqual(afterSecond);
    // The newer move's own Undo still works, back to after the first.
    expect((await post(undo, { token: await ticketOf(second) })).status).toBe(200);
    expect((await taskRow(mix)).dueAt!.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("a ticket that was edited, is someone else's, or has expired is refused", async () => {
    const res = await post(move, { kind: "task", id: mix, due_at: "2026-10-26T00:00:00.000Z" });
    const token = await ticketOf(res);
    const ticket = openUndo(token, U.id)!;
    expect(ticket).toMatchObject({ kind: "task", id: mix });
    const state = await mixState();
    // Edited: a lower postponed count with the old seal.
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...ticket, before: { ...(ticket as { before: object }).before, postponedCount: 0 } })).toString("base64url");
    expect((await post(undo, { token: `${forged}.${sig}` })).status).toBe(403);
    expect(body).not.toBe(forged);
    // Someone else's, sealed properly but for another user.
    expect((await post(undo, { token: sealUndo({ ...ticket, userId: OTHER.id }) })).status).toBe(403);
    // Expired.
    expect((await post(undo, { token: sealUndo({ ...ticket, exp: Date.now() - 1 }) })).status).toBe(403);
    expect(await mixState()).toEqual(state);
  });
});

describe("voice parity: saying it is the same tool (CLAUDE.md: one tool system)", () => {
  const ctx = () => liveTurnContext({ userId: U.id, timezone: U.tz, attachmentCount: 0 });

  it('"start the album cover on the 12th" by voice (amend_task) sets the planned start by a title fragment', async () => {
    const { result } = await executeTool(ctx(), "amend_task", { task: "album cover", start_at: "2026-10-12T09:00:00" });
    expect(result).not.toHaveProperty("error");
    const row = (await db.select().from(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, ids.cover))))[0];
    expect(row.startAt!.toISOString()).toBe("2026-10-12T16:00:00.000Z");
  });

  it("a spoken start after the due date is refused the same way, and nothing changes", async () => {
    const before = await taskRow(ids.stems);
    const { result } = await executeTool(ctx(), "amend_task", { task: "Send the stems", start_at: "2026-10-30" });
    expect(result).toMatchObject({ error: expect.stringMatching(/start can't be after the due date/) });
    expect(await taskRow(ids.stems)).toEqual(before);
  });

  it('a commitment taken on by voice can carry a start; "none" clears it; chat\'s create_task refuses a start after its due', async () => {
    const made = await executeTool(ctx(), "create_commitment", { title: "Write liner notes", start_at: "2026-10-13", due_at: "2026-10-20" });
    const id = (made.result as { task_id: string }).task_id;
    expect((await taskRow(id)).startAt).not.toBeNull();
    await executeTool(ctx(), "amend_task", { task: id, start_at: "none" });
    expect((await taskRow(id)).startAt).toBeNull();
    const bad = await executeTool(ctx(), "create_task", { title: "Backwards", start_at: "2026-10-25", due_at: "2026-10-20" });
    expect(bad.result).toMatchObject({ error: expect.stringMatching(/start can't be after the due date/) });
  });

  it("the voice tool list offers start_at on create_commitment and amend_task (flat strings)", () => {
    for (const name of ["create_commitment", "amend_task"]) {
      const def = openAIVoiceToolDefs().find((t) => t.name === name);
      const props = (def?.parameters as { properties: Record<string, { type?: string }> }).properties;
      expect(props.start_at?.type, name).toBe("string");
    }
  });
});
