// docs/understanding/SPEC.md §5: questions are ranked mechanically, kept by
// identity across runs, and the old ASR-kind rows retire once the user has
// confirmed the name by using it. The identity and rank checks run on bundles
// built by hand; the store checks run against the local database on
// throwaway users, one per describe so no block reads another's rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, conversations, entities, messages, projects, user } from "@/lib/db/schema";
import {
  getQuestion,
  listQuestions,
  questionIdentity,
  rankDraft,
  retireAsrClarifications,
  syncQuestions,
} from "@/lib/understanding/questions";
import type {
  Bundle,
  BundleEvent,
  BundleExpectation,
  BundleTask,
  QuestionDraft,
  QuestionKind,
  Source,
} from "@/lib/understanding/types";

// --------------------------------------------------------------------------
// Bundles by hand
// --------------------------------------------------------------------------

/** 2026-09-22 08:00 in Los Angeles. */
const NOW = new Date("2026-09-22T15:00:00.000Z");
const TZ = "America/Los_Angeles";
const HOUR_MS = 3_600_000;
const hours = (n: number) => new Date(NOW.getTime() + n * HOUR_MS).toISOString();
const days = (n: number) => hours(24 * n);

function task(id: string, over: Partial<BundleTask> = {}): BundleTask {
  return {
    id,
    title: `Task ${id}`,
    notes: null,
    status: "todo",
    stages: [],
    blockedReason: null,
    stakes: null,
    source: "typed",
    recurrence: null,
    dueAt: null,
    completedAt: null,
    createdAt: days(-30),
    updatedAt: days(-30),
    ...over,
  };
}

function event(id: string, startsAt: string): BundleEvent {
  return { id, title: `Event ${id}`, startsAt, endsAt: null, location: null, notes: null, projectId: "p" };
}

function expectation(id: string, status = "open"): BundleExpectation {
  return {
    id,
    taskId: null,
    commitment: `follow up ${id}`,
    expectedUpdateBy: days(-1),
    onMiss: "nag",
    status,
  };
}

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    userId: "u",
    project: { id: "p", name: "Caltrans", status: "active" },
    clock: {
      nowIso: NOW.toISOString(),
      timezone: TZ,
      localDate: "2026-09-22",
      tomorrowLocalDate: "2026-09-23",
    },
    tasksOpen: [],
    tasksDone: [],
    memories: [],
    messages: [],
    expectations: [],
    events: [],
    documents: [],
    previousRecord: null,
    widgets: [],
    projectNames: ["Caltrans"],
    dropped: [],
    terms: [],
    ...over,
  };
}

const src = (type: Source["type"], id: string): Source => ({ type, id });

function draft(kind: QuestionKind, evidence: Source[], over: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    kind,
    question: "Is this still right?",
    why: `"Task a" says so.`,
    evidence,
    answers: [
      { id: "yes", label: "Yes", writes: [{ op: "resolve" }] },
      { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
    ],
    ...over,
  };
}

// --------------------------------------------------------------------------
// questionIdentity
// --------------------------------------------------------------------------

describe("questionIdentity", () => {
  it("does not depend on the order of the evidence", () => {
    const a = questionIdentity({ kind: "doesnt_add_up", evidence: [src("task", "1"), src("task", "2")] });
    const b = questionIdentity({ kind: "doesnt_add_up", evidence: [src("task", "2"), src("task", "1")] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the kind", () => {
    const ev = [src("task", "1"), src("task", "2")];
    expect(questionIdentity({ kind: "doesnt_add_up", evidence: ev })).not.toBe(
      questionIdentity({ kind: "done_yet", evidence: ev })
    );
  });

  it("depends on the evidence set, type included, and not on quotes", () => {
    const base = questionIdentity({ kind: "need_to_know", evidence: [src("task", "1")] });
    expect(questionIdentity({ kind: "need_to_know", evidence: [src("task", "1"), src("message", "9")] })).not.toBe(
      base
    );
    expect(questionIdentity({ kind: "need_to_know", evidence: [src("memory", "1")] })).not.toBe(base);
    const quoted: Source[] = [{ type: "task", id: "1", quote: "a quote" }];
    expect(questionIdentity({ kind: "need_to_know", evidence: quoted })).toBe(base);
  });
});

// --------------------------------------------------------------------------
// rankDraft
// --------------------------------------------------------------------------

describe("rankDraft (SPEC §5 tiers)", () => {
  const tomorrow = task("soon", { dueAt: hours(20) });
  const nextWeek = task("later", { dueAt: days(5) });
  const undated = task("undated");
  const b = bundle({
    tasksOpen: [tomorrow, nextWeek, undated],
    events: [event("e-soon", hours(30)), event("e-later", days(6))],
  });

  it("a need_to_know with a task due within 48 hours is the hero: 0..99", () => {
    const r = rankDraft(draft("need_to_know", [src("task", "soon")]), b);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(100);
  });

  it("a need_to_know with an event starting within 48 hours is the hero too", () => {
    const r = rankDraft(draft("need_to_know", [src("event", "e-soon")]), b);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(100);
  });

  it("any other need_to_know is 100..199", () => {
    for (const ev of [[src("task", "later")], [src("task", "undated")], [src("event", "e-later")]]) {
      const r = rankDraft(draft("need_to_know", ev), b);
      expect(r, JSON.stringify(ev)).toBeGreaterThanOrEqual(100);
      expect(r, JSON.stringify(ev)).toBeLessThan(200);
    }
  });

  it("doesnt_add_up is 200..299 even when its evidence is due tomorrow", () => {
    const r = rankDraft(draft("doesnt_add_up", [src("task", "soon"), src("task", "later")]), b);
    expect(r).toBeGreaterThanOrEqual(200);
    expect(r).toBeLessThan(300);
  });

  it("done_yet is 300 and up, oldest evidence first", () => {
    const older = task("old", { createdAt: days(-60), updatedAt: days(-60) });
    const newer = task("new", { createdAt: days(-5), updatedAt: days(-5) });
    const bb = bundle({ tasksOpen: [older, newer] });
    const rOld = rankDraft(draft("done_yet", [src("task", "old")]), bb);
    const rNew = rankDraft(draft("done_yet", [src("task", "new")]), bb);
    expect(rOld).toBeGreaterThanOrEqual(300);
    expect(rNew).toBeGreaterThanOrEqual(300);
    expect(rOld).toBeLessThan(rNew);
  });

  it("done_yet reads a task's due date as its age when it has one", () => {
    const dueLongAgo = task("due-old", { dueAt: days(-40), createdAt: days(-3), updatedAt: days(-3) });
    const createdRecently = task("made-recently", { createdAt: days(-5), updatedAt: days(-5) });
    const bb = bundle({ tasksOpen: [dueLongAgo, createdRecently] });
    expect(rankDraft(draft("done_yet", [src("task", "due-old")]), bb)).toBeLessThan(
      rankDraft(draft("done_yet", [src("task", "made-recently")]), bb)
    );
  });

  it("within a tier, more evidence sorts first", () => {
    const three = draft("doesnt_add_up", [src("task", "soon"), src("task", "later"), src("task", "undated")]);
    const two = draft("doesnt_add_up", [src("task", "soon"), src("task", "later")]);
    expect(rankDraft(three, b)).toBeLessThan(rankDraft(two, b));
  });

  it("the tiers order as the spec lists them", () => {
    const hero = rankDraft(draft("need_to_know", [src("task", "soon")]), b);
    const other = rankDraft(draft("need_to_know", [src("task", "later")]), b);
    const dau = rankDraft(draft("doesnt_add_up", [src("task", "soon"), src("task", "later")]), b);
    const done = rankDraft(draft("done_yet", [src("task", "undated")]), b);
    expect(hero).toBeLessThan(other);
    expect(other).toBeLessThan(dau);
    expect(dau).toBeLessThan(done);
  });

  it("is deterministic", () => {
    const d = draft("doesnt_add_up", [src("task", "soon"), src("task", "later")]);
    expect(rankDraft(d, b)).toBe(rankDraft(d, b));
    expect(rankDraft({ ...d, evidence: [...d.evidence].reverse() }, b)).toBe(rankDraft(d, b));
  });
});

// --------------------------------------------------------------------------
// syncQuestions
// --------------------------------------------------------------------------

describe("syncQuestions", () => {
  const U = { id: `test-sync-${crypto.randomUUID()}`, email: `sync-${Date.now()}@p11.test` };
  let projectId = "";

  beforeAll(async () => {
    await db.insert(user).values({ id: U.id, name: "Sync Tester", email: U.email, timezone: TZ });
    const [p] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Caltrans", status: "active" })
      .returning();
    projectId = p.id;
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
  });

  const rows = () =>
    db
      .select()
      .from(clarifications)
      .where(eq(clarifications.userId, U.id))
      .orderBy(clarifications.createdAt);

  const open = () => bundle({ project: { id: projectId, name: "Caltrans", status: "active" }, tasksOpen: [task("a", { dueAt: hours(20) })] });
  const first = draft("need_to_know", [src("task", "a")], { question: "Is Task a due tomorrow?" });
  let id = "";

  it("creates a row with the draft's identity, rank, and why as context", async () => {
    const b = open();
    const r = await syncQuestions(U.id, projectId, [first], b);
    expect(r.created).toHaveLength(1);
    expect(r.updated).toEqual([]);
    expect(r.dismissed).toEqual([]);
    id = r.created[0];
    const [row] = await rows();
    expect(row.id).toBe(id);
    expect(row.kind).toBe("need_to_know");
    expect(row.status).toBe("open");
    expect(row.projectId).toBe(projectId);
    expect(row.question).toBe(first.question);
    expect(row.context).toBe(first.why);
    expect(row.identity).toBe(questionIdentity(first));
    expect(row.rank).toBe(rankDraft(first, b));
    expect(row.evidence).toEqual(first.evidence);
    expect(row.answers).toEqual(first.answers);
    expect(row.surfacedAt).toBeNull();
  });

  it("updates an open or asked row in place, keeping its status and surfacedAt", async () => {
    const surfaced = new Date("2026-09-21T16:00:00.000Z");
    await db
      .update(clarifications)
      .set({ status: "asked", surfacedAt: surfaced, askedAt: surfaced })
      .where(eq(clarifications.id, id));
    const reworded = draft("need_to_know", [src("task", "a")], {
      question: "Is Task a really due tomorrow?",
      why: `"Task a" is due in 20 hours.`,
      answers: [
        { id: "yes", label: "Yes", writes: [{ op: "resolve" }] },
        { id: "move", label: "Move it a week", writes: [{ op: "set_due", taskId: "a", dueAt: "2026-09-29" }, { op: "resolve" }] },
        { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
      ],
    });
    const r = await syncQuestions(U.id, projectId, [reworded], open());
    expect(r).toEqual({ created: [], updated: [id], dismissed: [] });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].question).toBe(reworded.question);
    expect(all[0].context).toBe(reworded.why);
    expect(all[0].answers.map((a) => a.label)).toEqual(["Yes", "Move it a week", "Not yet"]);
    expect(all[0].status).toBe("asked");
    expect(all[0].surfacedAt?.toISOString()).toBe(surfaced.toISOString());
  });

  it("leaves a forgotten question alone while its evidence is unchanged", async () => {
    const r = await syncQuestions(U.id, projectId, [], open());
    expect(r).toEqual({ created: [], updated: [], dismissed: [] });
    const [row] = await rows();
    expect(row.status).toBe("asked");
  });

  it("dismisses a forgotten question once an evidence task is finished after it was asked", async () => {
    // Finished on the database's clock: the row's created_at is wall-clock
    // time, and only a task finished AFTER that counts as the data moving.
    const finished = new Date().toISOString();
    const gone = bundle({ project: { id: projectId, name: "Caltrans", status: "active" }, tasksOpen: [], tasksDone: [task("a", { status: "done", completedAt: finished, updatedAt: finished })] });
    const r = await syncQuestions(U.id, projectId, [], gone);
    expect(r).toEqual({ created: [], updated: [], dismissed: [id] });
    const [row] = await rows();
    expect(row.status).toBe("dismissed");
    expect(row.resolution).toBe("resolved by a change in the data");
  });

  it("never re-creates a dismissed identity, even when the draft comes back", async () => {
    const r = await syncQuestions(U.id, projectId, [first], open());
    expect(r).toEqual({ created: [], updated: [], dismissed: [] });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("dismissed");
  });

  it("leaves a forgotten question alone when its evidence was already finished when it was asked", async () => {
    // The duplicate-CPO shape (SPEC §1): the question cites the done copy and
    // the open copy. The done copy was done on the day it was asked, so a run
    // that omits the question changes nothing; only finishing the open copy
    // afterwards does.
    const project = { id: projectId, name: "Caltrans", status: "active" };
    const doneCopy = task("done-copy", { status: "done", completedAt: days(-20), updatedAt: days(-20) });
    const twin = bundle({ project, tasksOpen: [task("open-copy")], tasksDone: [doneCopy] });
    const ask = draft("doesnt_add_up", [src("task", "done-copy"), src("task", "open-copy")], {
      question: "Is this on the list twice?",
      why: `"Task done-copy" is finished but "Task open-copy" is still open.`,
    });
    const created = await syncQuestions(U.id, projectId, [ask], twin);
    expect(created.created).toHaveLength(1);
    const forgot = await syncQuestions(U.id, projectId, [], twin);
    expect(forgot).toEqual({ created: [], updated: [], dismissed: [] });
    expect((await rows()).find((x) => x.id === created.created[0])!.status).toBe("open");

    const finished = new Date().toISOString();
    const closed = bundle({
      project,
      tasksOpen: [],
      tasksDone: [doneCopy, task("open-copy", { status: "done", completedAt: finished, updatedAt: finished })],
    });
    const after = await syncQuestions(U.id, projectId, [], closed);
    expect(after.dismissed).toEqual(created.created);
  });

  it("dismisses a forgotten question once an evidence expectation is no longer open", async () => {
    const withX = bundle({ project: { id: projectId, name: "Caltrans", status: "active" }, expectations: [expectation("x1")] });
    const ask = draft("done_yet", [src("expectation", "x1")], {
      question: "Did the follow-up land?",
      why: `"follow up x1" was expected yesterday.`,
    });
    const created = await syncQuestions(U.id, projectId, [ask], withX);
    expect(created.created).toHaveLength(1);
    const cleared = bundle({ project: { id: projectId, name: "Caltrans", status: "active" }, expectations: [] });
    const r = await syncQuestions(U.id, projectId, [], cleared);
    expect(r.dismissed).toEqual(created.created);
    const row = (await rows()).find((x) => x.id === created.created[0])!;
    expect(row.status).toBe("dismissed");
    expect(row.resolution).toBe("resolved by a change in the data");
  });

  it("a follow-up going missed is the calendar passing, not a change: the question stays", async () => {
    // "A missed follow-up" is one of done_yet's own triggers (SPEC §5), so a
    // question can only ever cite one in that state.
    const project = { id: projectId, name: "Caltrans", status: "active" };
    const missed = bundle({ project, expectations: [expectation("x2", "missed")] });
    const ask = draft("done_yet", [src("expectation", "x2")], {
      question: "Did the follow-up happen?",
      why: `"follow up x2" was expected yesterday and nothing came.`,
    });
    const created = await syncQuestions(U.id, projectId, [ask], missed);
    expect(created.created).toHaveLength(1);
    const r = await syncQuestions(U.id, projectId, [], missed);
    expect(r.dismissed).toEqual([]);
    expect((await rows()).find((x) => x.id === created.created[0])!.status).toBe("open");
    // Clearing it (the user reported) is the change that answers the question.
    const cleared = bundle({ project, expectations: [] });
    expect((await syncQuestions(U.id, projectId, [], cleared)).dismissed).toEqual(created.created);
  });

  it("only touches this project's rows", async () => {
    const [other] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Album", status: "active" })
      .returning();
    try {
      const albumBundle = bundle({ project: { id: other.id, name: "Album", status: "active" }, tasksOpen: [task("b")] });
      const theirs = draft("done_yet", [src("task", "b")], { why: `"Task b" is done, surely?` });
      const created = await syncQuestions(U.id, other.id, [theirs], albumBundle);
      expect(created.created).toHaveLength(1);
      // A Caltrans run with an empty bundle would dismiss anything of its own
      // whose evidence is gone; the Album row is not its business.
      const r = await syncQuestions(U.id, projectId, [], bundle({ project: { id: projectId, name: "Caltrans", status: "active" } }));
      expect(r.dismissed).toEqual([]);
      const row = (await rows()).find((x) => x.id === created.created[0])!;
      expect(row.status).toBe("open");
    } finally {
      await db.delete(projects).where(and(eq(projects.userId, U.id), eq(projects.id, other.id)));
    }
  });
});

// --------------------------------------------------------------------------
// retireAsrClarifications
// --------------------------------------------------------------------------

describe("retireAsrClarifications (SPEC §5, confirmed by use)", () => {
  const U = { id: `test-asr-${crypto.randomUUID()}`, email: `asr-${Date.now()}@p11.test` };
  const c = { alias: "", byUse: "", unused: "", unconfirmed: "", newKind: "", resolved: "" };

  beforeAll(async () => {
    await db.insert(user).values({ id: U.id, name: "ASR Tester", email: U.email, timezone: TZ });
    await db.insert(entities).values([
      { userId: U.id, name: "Walter Maiara", kind: "person", aliases: ["Walter Myala"], confirmed: true },
      // Heard once, spelling unconfirmed: not a confirmation of anything.
      { userId: U.id, name: "Pay-Aye-Test", kind: "term", confirmed: false },
    ]);
    const [conv] = await db
      .insert(conversations)
      .values({ userId: U.id, mode: "voice" })
      .returning();
    const say = (content: string, role: "user" | "assistant" = "user") => ({
      userId: U.id,
      conversationId: conv.id,
      role,
      mode: "voice" as const,
      content,
    });
    await db.insert(messages).values([
      say("I need to do the CalCard reconcile this week"),
      say("The CalCard statement came in"),
      say("calcard is due Friday, remind me"),
      say("Beacon glue is Marissa's first priority"),
      // The assistant saying a name three times confirms nothing.
      say("Beacon glue: noted.", "assistant"),
      say("Beacon glue is on the list.", "assistant"),
      say("Beacon glue, still open.", "assistant"),
    ]);
    const inserted = await db
      .insert(clarifications)
      .values([
        // Lowercase on purpose: the match is case-insensitive.
        { userId: U.id, kind: "asr_span", subject: "walter myala", question: "I heard Walter Myala — who is that?", status: "open" },
        { userId: U.id, kind: "asr_span", subject: "CalCard", question: "I heard CalCard — is that a card?", status: "asked" },
        { userId: U.id, kind: "asr_span", subject: "Beacon", question: "I heard Beacon — what is that?", status: "open" },
        { userId: U.id, kind: "new_name", subject: "Pay-Aye-Test", question: "How is Pay-Aye-Test spelled?", status: "open" },
        // A new-kind row that happens to share a subject: never touched.
        { userId: U.id, kind: "need_to_know", subject: "CalCard", question: "Which CalCard is next?", status: "open" },
        { userId: U.id, kind: "referent", subject: "Walter Myala", question: "Which Walter?", status: "resolved", resolution: "the same one" },
      ])
      .returning({ id: clarifications.id });
    [c.alias, c.byUse, c.unused, c.unconfirmed, c.newKind, c.resolved] = inserted.map((r) => r.id);
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
  });

  const statusOf = async (id: string) => {
    const [row] = await db
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(eq(clarifications.id, id));
    return row.status;
  };

  it("dismisses a subject that is a confirmed entity's alias, and one the user has used three times", async () => {
    const n = await retireAsrClarifications(U.id);
    expect(n).toBe(2);
    expect(await statusOf(c.alias)).toBe("dismissed");
    expect(await statusOf(c.byUse)).toBe("dismissed");
  });

  it("leaves the rest: one use is not confirmation, an unconfirmed entity is not either, and the new kinds are not its business", async () => {
    expect(await statusOf(c.unused)).toBe("open");
    expect(await statusOf(c.unconfirmed)).toBe("open");
    expect(await statusOf(c.newKind)).toBe("open");
    expect(await statusOf(c.resolved)).toBe("resolved");
    // Running again finds nothing new.
    expect(await retireAsrClarifications(U.id)).toBe(0);
  });

  it("counts the messages it is handed instead of reading the database when opts.messages is given", async () => {
    const n = await retireAsrClarifications(U.id, {
      messages: [
        { content: "Beacon glue first" },
        { content: "then the Beacon components" },
        { content: "Beacon is Marissa's" },
      ],
    });
    expect(n).toBe(1);
    expect(await statusOf(c.unused)).toBe("dismissed");
    expect(await statusOf(c.newKind)).toBe("open");
  });

  it("measures the 90-day window from the clock it is given, not the wall clock", async () => {
    const [row] = await db
      .insert(clarifications)
      .values({ userId: U.id, kind: "asr_span", subject: "CalCard", question: "I heard CalCard again?", status: "open" })
      .returning({ id: clarifications.id });
    // Seen from 120 days on, today's three CalCard messages are out of the window.
    const later = new Date(Date.now() + 120 * 86_400_000);
    expect(await retireAsrClarifications(U.id, { now: later })).toBe(0);
    expect(await statusOf(row.id)).toBe("open");
    expect(await retireAsrClarifications(U.id)).toBe(1);
    expect(await statusOf(row.id)).toBe("dismissed");
  });
});

// --------------------------------------------------------------------------
// listQuestions and getQuestion
// --------------------------------------------------------------------------

describe("listQuestions and getQuestion", () => {
  const U = { id: `test-list-${crypto.randomUUID()}`, email: `list-${Date.now()}@p11.test` };
  const other = { id: `test-list-other-${crypto.randomUUID()}`, email: `list-other-${Date.now()}@p11.test` };
  const p = { caltrans: "", album: "" };
  const q = { hero: "", asked: "", older250: "", newer250: "", resolved: "", asr: "" };
  const t0 = new Date("2026-09-20T12:00:00.000Z");
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
  const evidence: Source[] = [{ type: "task", id: "t1" }];

  beforeAll(async () => {
    await db.insert(user).values([
      { id: U.id, name: "List Tester", email: U.email, timezone: TZ },
      { id: other.id, name: "Someone Else", email: other.email, timezone: TZ },
    ]);
    const [caltrans] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Caltrans", status: "active" })
      .returning();
    const [album] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Album", status: "active" })
      .returning();
    p.caltrans = caltrans.id;
    p.album = album.id;
    const base = { userId: U.id, evidence, answers: [{ id: "ok", label: "Fine", writes: [{ op: "resolve" as const }] }] };
    const inserted = await db
      .insert(clarifications)
      .values([
        { ...base, kind: "need_to_know", question: "Which CPO is next?", context: "why hero", rank: 10, projectId: caltrans.id, status: "open", createdAt: at(0), identity: "id-hero" },
        { ...base, kind: "doesnt_add_up", question: "Twice?", context: "why asked", rank: 5, projectId: album.id, status: "asked", createdAt: at(1), surfacedAt: at(2), identity: "id-asked" },
        { ...base, kind: "done_yet", question: "Done yet, older?", context: "why older", rank: 250, projectId: caltrans.id, status: "open", createdAt: at(-10), identity: "id-older" },
        { ...base, kind: "done_yet", question: "Done yet, newer?", context: "why newer", rank: 250, projectId: album.id, status: "open", createdAt: at(3), identity: "id-newer" },
        { ...base, kind: "need_to_know", question: "Already answered?", context: "why resolved", rank: 0, projectId: caltrans.id, status: "resolved", createdAt: at(4), identity: "id-resolved" },
        { userId: U.id, kind: "asr_span", subject: "CPO", question: "I heard CPO?", status: "open", createdAt: at(5) },
      ])
      .returning({ id: clarifications.id });
    [q.hero, q.asked, q.older250, q.newer250, q.resolved, q.asr] = inserted.map((r) => r.id);
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
    await db.delete(user).where(eq(user.id, other.id));
  });

  it("lists open and asked rows of the three kinds by rank, then age, with the project name", async () => {
    const list = await listQuestions(U.id);
    expect(list.map((r) => r.id)).toEqual([q.asked, q.hero, q.older250, q.newer250]);
    const hero = list[1];
    expect(hero.kind).toBe("need_to_know");
    expect(hero.question).toBe("Which CPO is next?");
    expect(hero.why).toBe("why hero");
    expect(hero.rank).toBe(10);
    expect(hero.projectId).toBe(p.caltrans);
    expect(hero.projectName).toBe("Caltrans");
    expect(hero.status).toBe("open");
    expect(hero.surfacedAt).toBeNull();
    expect(hero.createdAt.toISOString()).toBe(at(0).toISOString());
    expect(hero.evidence).toEqual(evidence);
    expect(hero.answers.map((a) => a.label)).toEqual(["Fine"]);
    const asked = list[0];
    expect(asked.projectName).toBe("Album");
    expect(asked.status).toBe("asked");
    expect(asked.surfacedAt?.toISOString()).toBe(at(2).toISOString());
  });

  it("honours a limit", async () => {
    const list = await listQuestions(U.id, { limit: 2 });
    expect(list.map((r) => r.id)).toEqual([q.asked, q.hero]);
  });

  it("getQuestion returns the row for its owner, null for anyone else and for an unknown id", async () => {
    const mine = await getQuestion(U.id, q.hero);
    expect(mine).not.toBeNull();
    expect(mine!.id).toBe(q.hero);
    expect(mine!.projectName).toBe("Caltrans");
    expect(mine!.why).toBe("why hero");
    expect(await getQuestion(other.id, q.hero)).toBeNull();
    expect(await getQuestion(U.id, "not-a-question")).toBeNull();
  });
});
