// docs/understanding/SPEC.md §3: the bundle one run reads, built from the
// duplicate-CPO scenario in §1, against the local database. The point of the
// scenario is that the meaning of the CPO thread lives in rows with no
// project link — a memory, two messages — and the bundle has to find them by
// the words in them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations,
  documents,
  events,
  expectations,
  memories,
  messages,
  projects,
  records,
  tasks,
  user,
  workspaces,
} from "@/lib/db/schema";
import { gatherAll, gatherProject, hashBundle, nearDated } from "@/lib/understanding/gather";
import { recordSchema, type ProjectRecord } from "@/lib/understanding/types";
import { getBoard } from "@/lib/workspace/store";

const U = {
  id: `test-understanding-${crypto.randomUUID()}`,
  email: `understanding-${Date.now()}@p11.test`,
};
const TZ = "America/Los_Angeles";
// A fixed instant so "today" and every window are the same in every assertion.
const NOW = new Date("2026-09-21T18:00:00.000Z");
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const ids = {
  caltrans: "",
  album: "",
  doneCpo: "",
  blockedCpo: "",
  checkCpo: "",
  albumOverdue: "",
  memStatement: "",
  memAlbum: "",
  msgStatement: "",
  msgCpo: "",
  msgMilk: "",
  expectation: "",
  eventLinked: "",
  eventTerm: "",
  eventDentist: "",
  document: "",
};

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Understanding Tester", email: U.email, timezone: TZ });

  const [caltrans] = await db
    .insert(projects)
    .values({ userId: U.id, name: "Caltrans", status: "active" })
    .returning();
  const [album] = await db
    .insert(projects)
    .values({ userId: U.id, name: "Album", status: "active" })
    .returning();
  ids.caltrans = caltrans.id;
  ids.album = album.id;

  // The duplicate-CPO scenario (SPEC §1).
  const [doneCpo] = await db
    .insert(tasks)
    .values({
      userId: U.id,
      projectId: caltrans.id,
      title:
        "CPO 2073 — Production monitor: convert to FY2027, create new CPO, obtain Marissa signature, send to Walter Myala",
      notes: "new number is 0394",
      status: "done",
      completedAt: daysFromNow(-20),
      updatedAt: daysFromNow(-20),
      createdAt: daysFromNow(-40),
    })
    .returning();
  const [blockedCpo] = await db
    .insert(tasks)
    .values({
      userId: U.id,
      projectId: caltrans.id,
      title: "Process CPO 2073 / Production monitor as an FY 2027 transaction this month",
      status: "blocked",
      dueAt: daysFromNow(-5),
      stages: [
        { name: "Update", done: false },
        { name: "Sign", done: false },
        { name: "Pay", done: false },
        { name: "Reconcile and submit", done: false },
      ],
      updatedAt: daysFromNow(-30),
      createdAt: daysFromNow(-45),
    })
    .returning();
  const [checkCpo] = await db
    .insert(tasks)
    .values({
      userId: U.id,
      projectId: caltrans.id,
      title: "Check what is blocking CPO 2073 and report back",
      status: "todo",
      dueAt: daysFromNow(-2),
      updatedAt: daysFromNow(-13),
      createdAt: daysFromNow(-13),
    })
    .returning();
  // One overdue task on the other project: the Overdue widget then has two
  // Caltrans rows and one Album row, and Caltrans must own it.
  const [albumOverdue] = await db
    .insert(tasks)
    .values({
      userId: U.id,
      projectId: album.id,
      title: "Master the title track",
      status: "todo",
      dueAt: daysFromNow(-1),
    })
    .returning();
  ids.doneCpo = doneCpo.id;
  ids.blockedCpo = blockedCpo.id;
  ids.checkCpo = checkCpo.id;
  ids.albumOverdue = albumOverdue.id;

  const [memStatement] = await db
    .insert(memories)
    .values({
      userId: U.id,
      fact: "The US Bank statement is part of the user's CPO reconciliation process.",
      tags: ["Caltrans"],
    })
    .returning();
  const [memAlbum] = await db
    .insert(memories)
    .values({
      userId: U.id,
      fact: "The album cover needs a new photo before the release.",
      tags: ["Album"],
    })
    .returning();
  ids.memStatement = memStatement.id;
  ids.memAlbum = memAlbum.id;

  const [conv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode: "voice", startedAt: daysFromNow(-20) })
    .returning();
  const [msgStatement, msgCpo, msgMilk] = await db
    .insert(messages)
    .values([
      {
        userId: U.id,
        conversationId: conv.id,
        role: "user",
        mode: "voice",
        content: "All I need to do on the 22nd is change the bank statement",
        createdAt: daysFromNow(-20),
      },
      {
        userId: U.id,
        conversationId: conv.id,
        role: "user",
        mode: "voice",
        content: "I finished everything else that reconciling that CPO",
        createdAt: daysFromNow(-20),
      },
      {
        userId: U.id,
        conversationId: conv.id,
        role: "user",
        mode: "voice",
        content: "Remind me to buy milk on the way home",
        createdAt: daysFromNow(-1),
      },
      // The assistant's turn is never an input, however many terms it carries.
      {
        userId: U.id,
        conversationId: conv.id,
        role: "assistant",
        mode: "voice",
        content: "Noted: CPO 2073 for Caltrans is reconciled once the statement changes.",
        createdAt: daysFromNow(-20),
      },
    ])
    .returning();
  ids.msgStatement = msgStatement.id;
  ids.msgCpo = msgCpo.id;
  ids.msgMilk = msgMilk.id;

  const [expectation] = await db
    .insert(expectations)
    .values({
      userId: U.id,
      taskId: blockedCpo.id,
      commitment: "report on what is blocking the CPO",
      expectedUpdateBy: daysFromNow(2),
      status: "open",
    })
    .returning();
  ids.expectation = expectation.id;

  const [eventLinked, eventTerm, eventDentist] = await db
    .insert(events)
    .values([
      {
        userId: U.id,
        projectId: caltrans.id,
        title: "Sign the new form with Marissa",
        startsAt: daysFromNow(3),
      },
      // Not linked to the project; joins the bundle only by the words in it.
      { userId: U.id, title: "Call Walter about CPO 2073", startsAt: daysFromNow(4) },
      { userId: U.id, title: "Dentist", startsAt: daysFromNow(5) },
    ])
    .returning();
  ids.eventLinked = eventLinked.id;
  ids.eventTerm = eventTerm.id;
  ids.eventDentist = eventDentist.id;

  const [document] = await db
    .insert(documents)
    .values({ userId: U.id, projectId: caltrans.id, title: "CPO reconciliation notes" })
    .returning();
  ids.document = document.id;

  // The default board, seeded the way the app seeds it.
  await getBoard(U.id);
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const gather = (projectId = ids.caltrans, now = NOW) =>
  gatherProject(U.id, projectId, { now, timezone: TZ });

describe("the Caltrans bundle", () => {
  it("carries the three CPO tasks, open and done, with their fields", async () => {
    const b = await gather();
    expect(b).not.toBeNull();
    expect(b!.project).toEqual({ id: ids.caltrans, name: "Caltrans", status: "active" });
    expect(b!.tasksOpen.map((t) => t.id).sort()).toEqual([ids.blockedCpo, ids.checkCpo].sort());
    expect(b!.tasksDone.map((t) => t.id)).toEqual([ids.doneCpo]);

    const blocked = b!.tasksOpen.find((t) => t.id === ids.blockedCpo)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.stages).toHaveLength(4);
    expect(blocked.stages.every((s) => s.done === false)).toBe(true);
    expect(blocked.dueAt).toBe(daysFromNow(-5).toISOString());
    const done = b!.tasksDone[0];
    expect(done.notes).toBe("new number is 0394");
    expect(done.completedAt).toBe(daysFromNow(-20).toISOString());
  });

  it("derives its terms from the project name, the task titles and the task notes", async () => {
    const b = await gather();
    const lower = b!.terms.map((t) => t.toLowerCase());
    expect(lower).toContain("caltrans");
    expect(lower).toContain("cpo");
    expect(lower).toContain("2073");
    // 0394 exists only in the done task's notes. Digit tokens are taken from
    // notes on purpose (lib/understanding/terms.ts extractTerms): on the first
    // run there is no record yet whose things[].ids could carry it.
    expect(lower).toContain("0394");
    expect(lower).toContain("marissa");
    expect(lower).toContain("walter");
    // Sentence-starters from task titles never become terms.
    expect(lower).not.toContain("process");
    expect(lower).not.toContain("check");
    // Capitalized prose in notes never becomes a term either.
    expect(lower).not.toContain("new");
  });

  it("finds the memory by its tag and excludes the other project's memory", async () => {
    const b = await gather();
    expect(b!.memories.map((m) => m.id)).toEqual([ids.memStatement]);
    expect(b!.memories[0].tags).toEqual(["Caltrans"]);
  });

  it("finds the CPO message through the term CPO from the task titles, and only that one", async () => {
    const b = await gather();
    const got = b!.messages.map((m) => m.id);
    expect(got).toContain(ids.msgCpo);
    // "Remind me to buy milk" names nothing the project knows.
    expect(got).not.toContain(ids.msgMilk);
    // "change the bank statement" names nothing the project knows YET. It
    // joins once the record's things carry the statement as an alias — see
    // "the previous record widens the terms" below. This is the gap SPEC §1
    // describes, and it closes through the record, not through a wider net.
    expect(got).not.toContain(ids.msgStatement);
    expect(got).toHaveLength(1);
    expect(b!.messages[0].mode).toBe("voice");
  });

  it("carries the open expectation on the blocked task", async () => {
    const b = await gather();
    expect(b!.expectations.map((e) => e.id)).toEqual([ids.expectation]);
    expect(b!.expectations[0].taskId).toBe(ids.blockedCpo);
    expect(b!.expectations[0].status).toBe("open");
  });

  it("carries the linked event and the term-matched one, soonest first, and not the dentist", async () => {
    const b = await gather();
    expect(b!.events.map((e) => e.id)).toEqual([ids.eventLinked, ids.eventTerm]);
  });

  it("carries the project's document", async () => {
    const b = await gather();
    expect(b!.documents.map((d) => d.id)).toEqual([ids.document]);
  });

  it("a finished task is in the window by completed_at OR updated_at (SPEC §3)", async () => {
    // Completed 10 days ago but last edited 90 days ago: a fixture, a direct
    // write. It is still the evidence that an open twin is stale.
    const [oldEdit] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        projectId: ids.caltrans,
        title: "CPO 2110 — Lenses: paid",
        status: "done",
        completedAt: daysFromNow(-10),
        updatedAt: daysFromNow(-90),
        createdAt: daysFromNow(-100),
      })
      .returning();
    // And one finished outside the window on both counts stays out.
    const [ancient] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        projectId: ids.caltrans,
        title: "CPO 1992 — Comms: paid",
        status: "done",
        completedAt: daysFromNow(-70),
        updatedAt: daysFromNow(-70),
        createdAt: daysFromNow(-100),
      })
      .returning();
    try {
      const b = await gather();
      const done = b!.tasksDone.map((t) => t.id);
      expect(done).toContain(oldEdit.id);
      expect(done).not.toContain(ancient.id);
      // Most recently finished first: completed 10 days ago before 20.
      expect(done[0]).toBe(oldEdit.id);
    } finally {
      await db.delete(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, oldEdit.id)));
      await db.delete(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, ancient.id)));
    }
  });

  it("uses memories and messages handed in rather than reading them again", async () => {
    const b = await gatherProject(U.id, ids.caltrans, {
      now: NOW,
      timezone: TZ,
      memories: [],
      messages: [],
    });
    expect(b!.memories).toEqual([]);
    expect(b!.messages).toEqual([]);
    // Everything with a project link is still read.
    expect(b!.tasksOpen).toHaveLength(2);
  });

  it("nothing fell over a bound", async () => {
    const b = await gather();
    expect(b!.dropped).toEqual([]);
  });

  it("resolves the clock in the user's timezone", async () => {
    const b = await gather();
    // 2026-09-21T18:00Z is 11:00 in Los Angeles on the 21st.
    expect(b!.clock).toEqual({
      nowIso: NOW.toISOString(),
      timezone: TZ,
      localDate: "2026-09-21",
      tomorrowLocalDate: "2026-09-22",
    });
  });

  it("is null for a project that is not this user's", async () => {
    const [otherUser] = await db
      .insert(user)
      .values({ id: `${U.id}-other`, name: "Other", email: `other-${U.email}` })
      .returning();
    const [theirs] = await db
      .insert(projects)
      .values({ userId: otherUser.id, name: "Caltrans" })
      .returning();
    try {
      expect(await gather(theirs.id)).toBeNull();
    } finally {
      await db.delete(user).where(eq(user.id, otherUser.id));
    }
  });
});

describe("widgets: the project that owns the plurality of a widget's rows", () => {
  it("gives Caltrans the Overdue widget, with the row titles a lede may name", async () => {
    const b = await gather();
    const overdue = b!.widgets.find((w) => w.title === "Overdue");
    expect(overdue, JSON.stringify(b!.widgets)).toBeDefined();
    expect(overdue!.id).toBe("overdue");
    // Two Caltrans rows, one Album row: Caltrans wins the plurality.
    expect(overdue!.rows.map((r) => r.id).sort()).toEqual(
      [ids.blockedCpo, ids.checkCpo, ids.albumOverdue].sort()
    );
    expect(overdue!.rows.find((r) => r.id === ids.checkCpo)!.title).toBe(
      "Check what is blocking CPO 2073 and report back"
    );
    // Every open task here is Caltrans or Album; Caltrans has more.
    expect(b!.widgets.map((w) => w.title)).toContain("Everything open");
  });

  it("does not give the Album project the Overdue widget", async () => {
    const b = await gather(ids.album);
    expect(b!.widgets.map((w) => w.title)).not.toContain("Overdue");
    expect(b!.tasksOpen.map((t) => t.id)).toEqual([ids.albumOverdue]);
  });

  it("gatherAll covers every active project and resolves the board once", async () => {
    const all = await gatherAll(U.id, { now: NOW, timezone: TZ });
    expect(all.map((b) => b.project.name)).toEqual(["Album", "Caltrans"]);
    const caltrans = all.find((b) => b.project.name === "Caltrans")!;
    expect(caltrans.widgets.map((w) => w.title)).toContain("Overdue");
    // The shared memory and message reads still land on the right project.
    const album = all.find((b) => b.project.name === "Album")!;
    expect(caltrans.memories.map((m) => m.id)).toEqual([ids.memStatement]);
    expect(caltrans.messages.map((m) => m.id)).toEqual([ids.msgCpo]);
    expect(album.memories.map((m) => m.id)).toEqual([ids.memAlbum]);
    expect(album.messages).toEqual([]);
  });

  it("a widget whose rows name a project two projects share belongs to nobody", async () => {
    // `projects` has no unique (user_id, name); rows carry only the name. Two
    // runs writing one lede would be a contradiction the loop itself made.
    const [twin] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Caltrans", status: "active" })
      .returning();
    try {
      expect((await gather())!.widgets.map((w) => w.title)).not.toContain("Overdue");
      expect((await gather(twin.id))!.widgets.map((w) => w.title)).not.toContain("Overdue");
    } finally {
      await db.delete(projects).where(and(eq(projects.userId, U.id), eq(projects.id, twin.id)));
    }
    expect((await gather())!.widgets.map((w) => w.title)).toContain("Overdue");
  });
});

describe("hashBundle", () => {
  it("is stable across two gathers", async () => {
    const a = await gather();
    const b = await gather();
    expect(hashBundle(a!)).toBe(hashBundle(b!));
    expect(hashBundle(a!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores row order", async () => {
    const a = await gather();
    const shuffled = {
      ...a!,
      tasksOpen: [...a!.tasksOpen].reverse(),
      events: [...a!.events].reverse(),
      widgets: a!.widgets.map((w) => ({ ...w, rows: [...w.rows].reverse() })).reverse(),
    };
    expect(hashBundle(shuffled)).toBe(hashBundle(a!));
  });

  it("changes when the local date changes for a project with something dated near now", async () => {
    const today = await gather();
    const tomorrow = await gather(ids.caltrans, daysFromNow(1));
    expect(tomorrow!.clock.localDate).toBe("2026-09-22");
    // Same rows either way; only the date moved.
    expect(tomorrow!.tasksOpen.map((t) => t.id).sort()).toEqual(
      today!.tasksOpen.map((t) => t.id).sort()
    );
    // A task due in two days makes the project near-dated on both days.
    type B = NonNullable<Awaited<ReturnType<typeof gather>>>;
    const near = (b: B): B => ({
      ...b,
      tasksOpen: [
        { ...b.tasksOpen[0], dueAt: daysFromNow(2).toISOString() },
        ...b.tasksOpen.slice(1),
      ],
    });
    expect(nearDated(near(today!))).toBe(true);
    expect(hashBundle(near(tomorrow!))).not.toBe(hashBundle(near(today!)));
  });

  it("ignores the local date for a project with nothing dated near now (SPEC §8: no daily re-run)", async () => {
    const today = await gather();
    const tomorrow = await gather(ids.caltrans, daysFromNow(1));
    type B = NonNullable<Awaited<ReturnType<typeof gather>>>;
    // Every due date a month out, no events: a day passing changes nothing
    // the record says, so it must not cost a model call.
    const far = (b: B): B => ({
      ...b,
      tasksOpen: b.tasksOpen.map((t) => ({ ...t, dueAt: daysFromNow(30).toISOString() })),
      events: [],
    });
    expect(nearDated(far(today!))).toBe(false);
    expect(hashBundle(far(tomorrow!))).toBe(hashBundle(far(today!)));
    // An event within three days is enough on its own.
    const soon = (b: B): B => ({
      ...far(b),
      events: b.events.length
        ? [{ ...b.events[0], startsAt: daysFromNow(2).toISOString() }]
        : b.events,
    });
    if (today!.events.length) expect(nearDated(soon(today!))).toBe(true);
  });

  it("changes when a task's updated_at changes", async () => {
    const before = await gather();
    const touch = (updatedAt: Date) =>
      db
        .update(tasks)
        .set({ updatedAt })
        .where(and(eq(tasks.id, ids.checkCpo), eq(tasks.userId, U.id)));
    await touch(daysFromNow(-12));
    try {
      const after = await gather();
      expect(hashBundle(after!)).not.toBe(hashBundle(before!));
    } finally {
      // Put it back so no other test in this file depends on this one.
      await touch(daysFromNow(-13));
    }
  });

  it("does not depend on the previous record or the terms", async () => {
    const a = await gather();
    const withRecord = { ...a!, previousRecord: recordSchema.parse({ lastActivityAt: "x" }), terms: [] };
    expect(hashBundle(withRecord)).toBe(hashBundle(a!));
  });
});

describe("the previous record widens the terms", () => {
  // The record exists only inside this describe, so the bundles asserted
  // elsewhere in this file never see the alias it adds, in whatever order the
  // blocks run.
  let body: ProjectRecord;

  beforeAll(async () => {
    body = recordSchema.parse({
      things: [
        {
          name: "Production monitor",
          aliases: ["bank statement"],
          ids: ["0394"],
          state: {
            text: "Converted and signed; reconcile after the statement.",
            sources: [{ type: "task", id: ids.doneCpo }],
            confidence: "high",
          },
        },
      ],
      lastActivityAt: "2026-09-01",
    });
    await db.insert(records).values({
      userId: U.id,
      projectId: ids.caltrans,
      body,
      inputsHash: "seed",
    });
  });

  afterAll(async () => {
    await db
      .delete(records)
      .where(and(eq(records.userId, U.id), eq(records.projectId, ids.caltrans)));
  });

  it("a thing alias on the stored record pulls in the bank-statement message", async () => {
    const b = await gather();
    expect(b!.previousRecord).toEqual(body);
    expect(b!.terms.map((t) => t.toLowerCase())).toContain("bank statement");
    expect(b!.messages.map((m) => m.id).sort()).toEqual([ids.msgCpo, ids.msgStatement].sort());
    // Terms are not part of the hash, but the message that joined is.
    expect(b!.terms).not.toContain("previousRecord");
  });

  it("the record row is per (user, project) and goes with the user", async () => {
    const [row] = await db
      .select({ id: records.id })
      .from(records)
      .where(and(eq(records.userId, U.id), eq(records.projectId, ids.caltrans)));
    expect(row).toBeDefined();
    await expect(
      db.insert(records).values({
        userId: U.id,
        projectId: ids.caltrans,
        body: recordSchema.parse({ lastActivityAt: "y" }),
        inputsHash: "dup",
      })
    ).rejects.toThrow();
    // The board and the record both cascade from the user (afterAll relies on it).
    const [board] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.userId, U.id));
    expect(board).toBeDefined();
  });
});
