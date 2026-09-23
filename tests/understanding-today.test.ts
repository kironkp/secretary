// docs/understanding/SPEC.md §7 (the Today line), §9 (the surface) and §10
// (suggestions never make the past-due number bigger), against the local
// database on one throwaway user seeded with the duplicate-CPO scenario and
// two questions inserted by hand. No model is involved: Today renders what is
// stored and never waits for a run (§8).
//
// The steps are a sequence: the first buildToday marks the questions as
// surfaced, and later steps assert on what that left behind, so the order is
// the point.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, events, records, tasks, user } from "@/lib/db/schema";
import { buildToday, cutQuote, mechanicalTodayLine, viewQuestion } from "@/lib/understanding/today";
import { getQuestion } from "@/lib/understanding/questions";
import type { ProjectRecord } from "@/lib/understanding/types";
import { CPO_NOW, CPO_TZ, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = {
  id: `test-understanding-today-${crypto.randomUUID()}`,
  email: `understanding-today-${Date.now()}@p11.test`,
};
const OTHER = {
  id: `test-understanding-today-other-${crypto.randomUUID()}`,
  email: `understanding-today-other-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
const DAY_MS = 86_400_000;
const at = (days: number, hours = 0) => new Date(NOW.getTime() + days * DAY_MS + hours * 3_600_000);

let ids: CpoIds;
let otherTaskId = "";
let heroId = "";
let rowId = "";

const emptyRecord = (): ProjectRecord => ({
  things: [],
  rules: [],
  decisions: [],
  currentWork: [],
  blockers: [],
  attempts: [],
  contradictions: [],
  unknowns: [],
  asked: [],
  lastActivityAt: NOW.toISOString(),
});

const today = () => buildToday(U.id, TZ, NOW);

const recordFor = async (projectId: string) => {
  const [row] = await db
    .select()
    .from(records)
    .where(and(eq(records.userId, U.id), eq(records.projectId, projectId)));
  return row;
};

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Understanding Today Tester", email: U.email, timezone: TZ },
    { id: OTHER.id, name: "Someone Else", email: OTHER.email, timezone: TZ },
  ]);
  ids = await seedCpoScenario(U.id, NOW);

  // Another user's task: its id will sit in the hero's evidence and must be
  // skipped, not shown.
  const [otherTask] = await db
    .insert(tasks)
    .values({ userId: OTHER.id, title: "Not yours", status: "todo" })
    .returning({ id: tasks.id });
  otherTaskId = otherTask.id;

  const [hero, row] = await db
    .insert(clarifications)
    .values([
      {
        userId: U.id,
        kind: "need_to_know",
        question: "Is the US Bank statement the last step before CPO 2073 is reconciled?",
        context: '"Do the US Bank statement" is due tomorrow, and you said "I finished everything else that reconciling that CPO".',
        evidence: [
          { type: "task", id: ids.statement },
          { type: "message", id: ids.msgFinished, quote: "I finished everything else that reconciling that CPO" },
          { type: "expectation", id: ids.expectation },
          { type: "task", id: otherTaskId },
        ],
        answers: [
          {
            id: "yes-last-step",
            label: "Yes, that is the last step",
            writes: [
              { op: "remember_fact", fact: "The US Bank statement is the last step of reconciling CPO 2073.", tags: ["Caltrans"] },
              { op: "resolve" },
            ],
          },
          { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
        ],
        rank: 0,
        projectId: ids.caltrans,
        identity: "today-hero",
        status: "open",
      },
      {
        userId: U.id,
        kind: "doesnt_add_up",
        question: "CPO 2073 is on your list twice?",
        context: "One copy is finished and says the new number is 0394; another is still open with 0 of 4 steps done.",
        evidence: [
          { type: "task", id: ids.doneCpo, quote: "new number is 0394" },
          { type: "task", id: ids.blockedCpo },
          { type: "task", id: ids.checkCpo },
          { type: "memory", id: ids.memMonthly },
          { type: "event", id: ids.eventLinked },
          { type: "document", id: ids.document },
        ],
        answers: [
          {
            id: "close-both",
            label: "Close both",
            writes: [
              { op: "complete_task", taskId: ids.blockedCpo },
              { op: "complete_task", taskId: ids.checkCpo },
              { op: "resolve" },
            ],
          },
          { id: "keep-them", label: "Keep them", writes: [{ op: "resolve" }] },
        ],
        rank: 200,
        projectId: ids.caltrans,
        identity: "today-row",
        status: "open",
      },
    ])
    .returning({ id: clarifications.id });
  heroId = hero.id;
  rowId = row.id;

  // A record with no words yet: the Today line must fall back mechanically.
  await db.insert(records).values({
    userId: U.id,
    projectId: ids.caltrans,
    body: emptyRecord(),
    inputsHash: "seed",
    words: { ledes: {} },
    updatedAt: at(-1),
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});

describe("buildToday on the duplicate-CPO scenario", () => {
  it("(1) the hero is the lowest rank, the rest are rows, and the counts and lists are the scenario's", async () => {
    const data = await today();

    expect(data.hero?.id).toBe(heroId);
    expect(data.hero?.kindLabel).toBe("Need to know");
    expect(data.questions.map((q) => q.id)).toEqual([rowId]);
    expect(data.questions[0].kindLabel).toBe("Doesn't add up");
    expect(data.counts.questions).toBe(2);
    // The question text is carried whole; nothing shortens it (§9).
    expect(data.hero?.question).toBe(
      "Is the US Bank statement the last step before CPO 2073 is reconciled?"
    );
    expect(data.hero?.projectName).toBe("Caltrans");

    // No record carries a Today line yet, and nothing is due today.
    expect(data.counts.dueToday).toBe(0);
    expect(data.dueToday).toEqual([]);
    expect(data.todayLine).toBe("Nothing is due today.");

    // Past due, soonest due first: the blocked copy (Aug 21), the check
    // (2 days ago), the album's track (yesterday). The statement is tomorrow.
    expect(data.pastDue.map((r) => r.id)).toEqual([ids.blockedCpo, ids.checkCpo, ids.albumOverdue]);
    expect(data.counts.pastDue).toBe(3);
    expect(data.counts.pastDueSuggested).toBe(0);
    expect(data.pastDue[0].fields.title).toBe(
      "Process CPO 2073 / Production monitor as an FY 2027 transaction this month"
    );
    expect(data.pastDue[0].fields.project).toBe("Caltrans");
    expect(data.pastDue[0].fields.source).toBe("typed");

    // Coming up: the three events inside seven days, in order.
    expect(data.comingUp.map((r) => r.id)).toEqual([ids.eventLinked, ids.eventTerm, ids.eventDentist]);

    expect(data.updatedAt).toBe(at(-1).toISOString());
  });

  it("(2) showing a question marks it surfaced and logs it as asked on the project's record, once", async () => {
    const first = await today();
    // The views say so immediately...
    expect(first.hero?.surfacedAt).toEqual(NOW);
    expect(first.questions[0].surfacedAt).toEqual(NOW);
    // ...and so does the database.
    const hero = await getQuestion(U.id, heroId);
    const row = await getQuestion(U.id, rowId);
    expect(hero?.surfacedAt).toEqual(NOW);
    expect(row?.surfacedAt).toEqual(NOW);
    // The status is untouched: surfaced is a timestamp, not a state change.
    expect(hero?.status).toBe("open");

    const record = await recordFor(ids.caltrans);
    // The entry carries the question's text and its evidence keys, not the id
    // alone: the next run reads this list to know what was already put to
    // the user, and an id told it nothing (SPEC §5).
    expect(record.body.asked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionId: heroId,
          askedAt: NOW.toISOString(),
          question: expect.any(String),
          evidence: expect.arrayContaining([expect.stringMatching(/^(task|message|memory|event|document|expectation):/)]),
        }),
        expect.objectContaining({ questionId: rowId, askedAt: NOW.toISOString() }),
      ])
    );
    expect(record.body.asked).toHaveLength(2);

    // A second Today does not ask again.
    await today();
    const again = await recordFor(ids.caltrans);
    expect(again.body.asked).toHaveLength(2);
  });

  it("(3) evidence reads as a person would: labelled, dated in the user's calendar, in full", async () => {
    const data = await today();
    const hero = data.hero!;

    // The other user's task is skipped in silence: three of four remain.
    expect(hero.evidenceView).toHaveLength(3);
    expect(hero.evidenceView.map((e) => e.id)).not.toContain(otherTaskId);

    const [statement, said, expected] = hero.evidenceView;
    expect(statement).toEqual({
      type: "task",
      id: ids.statement,
      label: "Still open",
      text: "Do the US Bank statement",
      meta: "due Sep 23",
    });
    expect(said).toEqual({
      type: "message",
      id: ids.msgFinished,
      label: "You, Sep 1",
      text: "I finished everything else that reconciling that CPO",
    });
    expect(expected).toEqual({
      type: "expectation",
      id: ids.expectation,
      label: "Expected by Sep 24",
      text: "report on what is blocking the CPO",
    });

    const row = data.questions[0];
    expect(row.evidenceView).toHaveLength(6);
    const [done, blocked, check, memory, event, document] = row.evidenceView;
    // The finished copy: dated by when it was finished, its full title as the
    // text, and the quote from its notes as a note under it.
    expect(done.label).toBe("Done Sep 1");
    expect(done.text).toBe(
      "CPO 2073 — Production monitor: convert to FY2027, create new CPO, obtain Marissa signature, send to Walter Myala"
    );
    expect(done.meta).toBe("note: new number is 0394");
    expect(blocked).toEqual({
      type: "task",
      id: ids.blockedCpo,
      label: "Still open",
      text: "Process CPO 2073 / Production monitor as an FY 2027 transaction this month",
      meta: "due Aug 21 · 0 of 4 steps",
    });
    expect(check.label).toBe("Still open");
    expect(check.meta).toBe("due Sep 20");
    // The memory was inserted at wall-clock time, so only the prefix is fixed.
    expect(memory.label).toMatch(/^Remembered [A-Z][a-z]{2} \d{1,2}$/);
    expect(memory.text).toBe("User is handling CPOs by doing/paying one each month and spacing them out.");
    expect(event).toEqual({
      type: "event",
      id: ids.eventLinked,
      label: "Event Sep 25",
      text: "Sign the new form with Marissa",
    });
    expect(document).toEqual({
      type: "document",
      id: ids.document,
      label: "Document",
      text: "CPO reconciliation notes",
      href: `/documents/${ids.document}`,
    });
  });

  it("(4) a message with no quote is shown whole up to 300 characters, cut on a word, and marked only when cut", async () => {
    const row = (await getQuestion(U.id, heroId))!;
    const view = await viewQuestion(U.id, { ...row, evidence: [{ type: "message", id: ids.msgFinished }] }, TZ);
    expect(view.evidenceView).toEqual([
      {
        type: "message",
        id: ids.msgFinished,
        label: "You, Sep 1",
        text: "All right, I finished everything else that reconciling that CPO",
      },
    ]);

    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    expect(long.length).toBeGreaterThan(300);
    const cut = cutQuote(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(301);
    // Whole words: the character before the mark is the end of a word.
    expect(cut.slice(0, -1)).toMatch(/word\d+$/);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cutQuote("  short  ")).toBe("short");
  });

  it("(5) a suggested task past its date is counted as a suggestion and never as past due (§10)", async () => {
    const [suggested] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        projectId: ids.caltrans,
        title: "Compile the prior-art results into a memo",
        status: "todo",
        source: "suggested",
        dueAt: at(-3),
      })
      .returning({ id: tasks.id });

    const data = await today();
    expect(data.pastDue.map((r) => r.id)).not.toContain(suggested.id);
    expect(data.counts.pastDue).toBe(3);
    expect(data.counts.pastDueSuggested).toBe(1);
    // The mechanical line is about today, and a suggestion changes nothing there.
    expect(data.todayLine).toBe("Nothing is due today.");
  });

  it("(6) the Today line comes from the project that owns the nearest dated item, else it is mechanical (§7)", async () => {
    // Caltrans has the statement due tomorrow, so its line owns the day.
    const caltransLine = "Nothing is due today. The US Bank statement is due tomorrow.";
    await db
      .update(records)
      .set({ words: { todayLine: caltransLine, ledes: {} }, updatedAt: at(-1) })
      .where(and(eq(records.userId, U.id), eq(records.projectId, ids.caltrans)));
    expect((await today()).todayLine).toBe(caltransLine);

    // The Album's only dated task is overdue (yesterday), which is before the
    // start of the day and does not count, so a newer Album record still loses.
    const albumLine = "The title track is next.";
    await db.insert(records).values({
      userId: U.id,
      projectId: ids.album,
      body: emptyRecord(),
      inputsHash: "seed-album",
      words: { todayLine: albumLine, ledes: {} },
      updatedAt: at(0),
    });
    expect((await today()).todayLine).toBe(caltransLine);

    // An Album event at 09:00 today is nearer than the statement tomorrow.
    const [listening] = await db
      .insert(events)
      .values({ userId: U.id, projectId: ids.album, title: "Listening session", startsAt: at(0, 1) })
      .returning({ id: events.id });
    expect((await today()).todayLine).toBe(albumLine);
    await db.delete(events).where(eq(events.id, listening.id));
    expect((await today()).todayLine).toBe(caltransLine);

    // A record whose line is blank is not a candidate; with none left the
    // line is mechanical, with days and counts as digits.
    await db.update(records).set({ words: { ledes: {} } }).where(eq(records.userId, U.id));
    const [dueToday] = await db
      .insert(tasks)
      .values({ userId: U.id, projectId: ids.album, title: "Send the stems", status: "todo", dueAt: at(0, 3) })
      .returning({ id: tasks.id });
    const data = await today();
    expect(data.counts.dueToday).toBe(1);
    expect(data.dueToday.map((r) => r.id)).toEqual([dueToday.id]);
    expect(data.todayLine).toBe("1 due today.");
    expect(mechanicalTodayLine(0)).toBe("Nothing is due today.");
    expect(mechanicalTodayLine(12)).toBe("12 due today.");
  });

  it("(7) a question answered elsewhere leaves the queue and the count", async () => {
    await db
      .update(clarifications)
      .set({ status: "resolved", resolution: "Keep them" })
      .where(eq(clarifications.id, rowId));
    const data = await today();
    expect(data.hero?.id).toBe(heroId);
    expect(data.questions).toEqual([]);
    expect(data.counts.questions).toBe(1);
  });

  it("(8) a backlog past fifty is listed fifty at a time but counted whole, suggestions apart (§10)", async () => {
    // 52 of the user's own, all older than anything seeded so far, and one
    // more suggestion: the list is the first fifty by date, the numbers are
    // everything.
    await db.insert(tasks).values([
      ...Array.from({ length: 52 }, (_, i) => ({
        userId: U.id,
        projectId: ids.album,
        title: `Backlog item ${i + 1}`,
        status: "todo" as const,
        dueAt: at(-100 + i),
      })),
      {
        userId: U.id,
        projectId: ids.album,
        title: "Another idea of mine",
        status: "todo" as const,
        source: "suggested" as const,
        dueAt: at(-2),
      },
    ]);
    const data = await today();
    expect(data.pastDue).toHaveLength(50);
    expect(data.pastDue.every((r) => r.fields.source !== "suggested")).toBe(true);
    expect(data.pastDue[0].fields.title).toBe("Backlog item 1");
    // 3 from the scenario + 52 here; the two suggestions are in neither.
    expect(data.counts.pastDue).toBe(55);
    expect(data.counts.pastDueSuggested).toBe(2);
  });
});
