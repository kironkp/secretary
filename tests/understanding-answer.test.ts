// docs/understanding/SPEC.md §6 (answering) and §10 (the honesty rule),
// against the local database on one throwaway user seeded with the
// duplicate-CPO scenario and questions inserted by hand. The writes go
// through the existing tool handlers, so the assertions look for what those
// leave behind — the check-in row, the cleared follow-up — and not only for
// the status change. No model is involved: the re-run after an answer is the
// route's to schedule, and under vitest it would skip anyway.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, clarifications, expectations, memories, records, tasks, user } from "@/lib/db/schema";
import { answerQuestion, dueInstantInTz } from "@/lib/understanding/answer";
import { localDateInTz } from "@/lib/understanding/gather";
import { getQuestion } from "@/lib/understanding/questions";
import type { ProjectRecord, Write } from "@/lib/understanding/types";
import { CPO_NOW, CPO_TZ, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = {
  id: `test-understanding-answer-${crypto.randomUUID()}`,
  email: `understanding-answer-${Date.now()}@p11.test`,
};
// A second user, so "not this user's question" is a tested 404, not a 409.
const OTHER = {
  id: `test-understanding-answer-other-${crypto.randomUUID()}`,
  email: `understanding-answer-other-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
const ASKED_AT = new Date(NOW.getTime() - 3_600_000).toISOString();

let ids: CpoIds;
const ghostTaskId = crypto.randomUUID();
let extraExpectationId = "";
const q = {
  close: "",
  outside: "",
  failing: "",
  fact: "",
  expect: "",
  note: "",
  due: "",
  drop: "",
  recur: "",
  block: "",
  race: "",
  malformed: "",
  foreign: "",
};
/** Album tasks seeded for the one-op questions, one per op so no test leans on another's write. */
const t = { due: "", drop: "", recur: "", block: "", race: "" };

const answer = (id: string, answerId: string, note?: string) =>
  answerQuestion(U.id, TZ, id, answerId, note);

const taskRow = async (id: string) => {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, id)));
  return row;
};

const recordFor = async (projectId: string) => {
  const [row] = await db
    .select()
    .from(records)
    .where(and(eq(records.userId, U.id), eq(records.projectId, projectId)));
  return row;
};

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Understanding Answer Tester", email: U.email, timezone: TZ },
    { id: OTHER.id, name: "Someone Else", email: OTHER.email, timezone: TZ },
  ]);
  ids = await seedCpoScenario(U.id, NOW);

  const [extra] = await db
    .insert(expectations)
    .values({
      userId: U.id,
      taskId: ids.statement,
      commitment: "say when the statement is changed",
      expectedUpdateBy: new Date(NOW.getTime() + 2 * 86_400_000),
      status: "open",
    })
    .returning({ id: expectations.id });
  extraExpectationId = extra.id;

  const base = { userId: U.id, rank: 0, status: "open" as const };
  const inserted = await db
    .insert(clarifications)
    .values([
      {
        ...base,
        kind: "doesnt_add_up",
        question: "CPO 2073 is on your list twice?",
        context: "One copy is finished; another is still open with 0 of 4 steps done.",
        projectId: ids.caltrans,
        identity: "answer-close",
        evidence: [
          { type: "task", id: ids.doneCpo },
          { type: "task", id: ids.blockedCpo },
          { type: "task", id: ids.checkCpo },
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
      },
      {
        ...base,
        kind: "need_to_know",
        question: "Is the statement done?",
        context: "The finished copy says everything else is done.",
        projectId: ids.caltrans,
        identity: "answer-outside",
        status: "asked",
        evidence: [{ type: "task", id: ids.doneCpo }],
        answers: [
          // Names a task that is not in the evidence: refused whole (§5, §6).
          {
            id: "close-statement",
            label: "Close the statement",
            writes: [{ op: "complete_task", taskId: ids.statement }, { op: "resolve" }],
          },
          { id: "leave", label: "Leave it", writes: [{ op: "resolve" }] },
        ],
      },
      {
        ...base,
        kind: "done_yet",
        question: "Did both of these happen?",
        context: "Both look finished.",
        projectId: ids.caltrans,
        identity: "answer-failing",
        evidence: [
          { type: "task", id: ghostTaskId },
          { type: "task", id: ids.statement },
        ],
        answers: [
          {
            id: "both-done",
            label: "Both done",
            writes: [
              { op: "complete_task", taskId: ghostTaskId },
              { op: "complete_task", taskId: ids.statement },
              { op: "resolve" },
            ],
          },
        ],
      },
      {
        ...base,
        kind: "need_to_know",
        question: "Is the US Bank statement the last step before CPO 2073 is reconciled?",
        context: 'You said "I finished everything else that reconciling that CPO".',
        projectId: ids.caltrans,
        identity: "answer-fact",
        evidence: [{ type: "memory", id: ids.memMonthly }],
        answers: [
          {
            id: "yes-last-step",
            label: "Yes, that is the last step",
            writes: [
              {
                op: "remember_fact",
                fact: "The US Bank statement is the last step of reconciling CPO 2073.",
                tags: ["Caltrans", "answered"],
              },
              { op: "resolve" },
            ],
          },
        ],
      },
      {
        ...base,
        kind: "done_yet",
        question: "Did you change the statement?",
        context: "You expected to say by Sep 24.",
        projectId: ids.caltrans,
        identity: "answer-expectation",
        evidence: [{ type: "expectation", id: extraExpectationId }],
        answers: [
          {
            id: "yes-changed",
            label: "Yes",
            writes: [{ op: "clear_expectation", expectationId: extraExpectationId }, { op: "resolve" }],
          },
        ],
      },
      {
        ...base,
        kind: "doesnt_add_up",
        question: "Is the title track still on?",
        context: "It was due yesterday.",
        // The Album has no record: the answer must still resolve cleanly.
        projectId: ids.album,
        identity: "answer-note",
        evidence: [{ type: "task", id: ids.albumOverdue }],
        answers: [{ id: "keep", label: "Keep", writes: [{ op: "resolve" }] }],
      },
    ])
    .returning({ id: clarifications.id });
  [q.close, q.outside, q.failing, q.fact, q.expect, q.note] = inserted.map((r) => r.id);

  // One Album task per remaining op, each overdue by a week so a set_due can
  // move it forward and the others have a real row to change.
  const albumTask = (title: string) => ({
    userId: U.id,
    projectId: ids.album,
    title,
    status: "todo" as const,
    dueAt: new Date(NOW.getTime() - 7 * 86_400_000),
  });
  const seeded = await db
    .insert(tasks)
    .values([
      albumTask("Book the mastering session"),
      albumTask("Chase the label about the artwork"),
      albumTask("Send the weekly mix to the band"),
      albumTask("Clear the sample on track 4"),
      albumTask("Order the test pressing"),
    ])
    .returning({ id: tasks.id });
  [t.due, t.drop, t.recur, t.block, t.race] = seeded.map((r) => r.id);

  const one = (identity: string, taskId: string, label: string, writes: Write[]) => {
    const all: Write[] = [...writes, { op: "resolve" }];
    return {
      ...base,
      kind: "need_to_know" as const,
      question: `What about ${identity}?`,
      context: "It is a week past its date.",
      projectId: ids.album,
      identity,
      evidence: [{ type: "task" as const, id: taskId }],
      answers: [{ id: "do-it", label, writes: all }],
    };
  };
  const more = await db
    .insert(clarifications)
    .values([
      // The model writes dueAt as YYYY-MM-DD in the user's timezone (prompt.ts).
      one("answer-due", t.due, "Move it to Oct 10", [{ op: "set_due", taskId: t.due, dueAt: "2026-10-10" }]),
      one("answer-drop", t.drop, "Drop it", [{ op: "drop_task", taskId: t.drop }]),
      one("answer-recur", t.recur, "Make it weekly", [
        { op: "set_recurrence", taskId: t.recur, recurrence: "weekly" },
      ]),
      one("answer-block", t.block, "It is stuck", [
        { op: "set_blocked_reason", taskId: t.block, reason: "Waiting on the publisher" },
      ]),
      one("answer-race", t.race, "Done", [{ op: "complete_task", taskId: t.race }]),
      // Stored by hand with an op outside the closed list (types.ts writeSchema).
      one("answer-malformed", t.race, "Delete it", [
        { op: "delete_task", taskId: t.race } as unknown as Write,
      ]),
    ])
    .returning({ id: clarifications.id });
  [q.due, q.drop, q.recur, q.block, q.race, q.malformed] = more.map((r) => r.id);

  const [foreign] = await db
    .insert(clarifications)
    .values({
      userId: OTHER.id,
      rank: 0,
      status: "open",
      kind: "need_to_know",
      question: "Is this yours?",
      context: "It is not.",
      identity: "answer-foreign",
      evidence: [],
      answers: [{ id: "keep", label: "Keep", writes: [{ op: "resolve" }] }],
    })
    .returning({ id: clarifications.id });
  q.foreign = foreign.id;

  // The Caltrans record has already asked the first question (Today showed
  // it); the others were never surfaced.
  const body: ProjectRecord = {
    things: [],
    rules: [],
    decisions: [],
    currentWork: [],
    blockers: [],
    attempts: [],
    contradictions: [],
    unknowns: [],
    asked: [{ questionId: q.close, askedAt: ASKED_AT }],
    lastActivityAt: NOW.toISOString(),
  };
  await db.insert(records).values({
    userId: U.id,
    projectId: ids.caltrans,
    body,
    inputsHash: "seed",
    words: { ledes: {} },
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});

describe("answerQuestion", () => {
  it("(1) an unknown question is not-found, an unknown answer is bad-answer, and neither changes anything", async () => {
    expect(await answer(crypto.randomUUID(), "close-both")).toEqual({ status: "not-found" });
    expect(await answer(q.close, "no-such-answer")).toEqual({ status: "bad-answer" });
    expect((await getQuestion(U.id, q.close))?.status).toBe("open");
    expect((await taskRow(ids.blockedCpo)).status).toBe("blocked");
  });

  it("(2) a write naming a task outside the evidence is refused whole: bad-answer, nothing changes", async () => {
    expect(await answer(q.outside, "close-statement")).toEqual({ status: "bad-answer" });
    expect((await taskRow(ids.statement)).status).toBe("todo");
    const [row] = await db
      .select({ status: clarifications.status, resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.outside));
    expect(row).toEqual({ status: "asked", resolution: null });
    const done = await db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, U.id), eq(checkins.taskId, ids.statement)));
    expect(done).toEqual([]);
  });

  it("(3) 'Close both' marks both tasks done through the tools and resolves the question with the answer's label", async () => {
    const result = await answer(q.close, "close-both");
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [
        { op: "complete_task", id: ids.blockedCpo },
        { op: "complete_task", id: ids.checkCpo },
      ],
      failed: [],
    });

    for (const id of [ids.blockedCpo, ids.checkCpo]) {
      const task = await taskRow(id);
      expect(task.status).toBe("done");
      expect(task.completedAt).not.toBeNull();
      // The tool's own trail: complete_task logs a check-in.
      const trail = await db
        .select({ note: checkins.note })
        .from(checkins)
        .where(and(eq(checkins.userId, U.id), eq(checkins.taskId, id)));
      expect(trail.map((c) => c.note)).toContain("Marked done");
    }
    // ...and clears the task's open follow-ups (the seeded expectation is on
    // the blocked copy), which is why the writes go through the tools.
    const [followUp] = await db
      .select({ status: expectations.status })
      .from(expectations)
      .where(eq(expectations.id, ids.expectation));
    expect(followUp.status).toBe("cleared");

    const row = await getQuestion(U.id, q.close);
    expect(row?.status).toBe("resolved");
    const [stored] = await db
      .select({ resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.close));
    expect(stored.resolution).toBe("Close both");

    // The record's asked entry keeps when it was asked and gains the answer.
    const record = await recordFor(ids.caltrans);
    const asked = record.body.asked.find((a) => a.questionId === q.close);
    expect(asked?.askedAt).toBe(ASKED_AT);
    expect(asked?.answer).toBe("Close both");
    expect(asked?.answeredAt).toBeDefined();
    expect(Date.parse(asked!.answeredAt!)).toBeGreaterThan(Date.parse(ASKED_AT));
    expect(record.body.asked).toHaveLength(1);
  });

  it("(4) a resolved question cannot be answered again", async () => {
    expect(await answer(q.close, "keep-them")).toEqual({ status: "not-open" });
    const [stored] = await db
      .select({ resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.close));
    expect(stored.resolution).toBe("Close both");
  });

  it("(5) a write that fails is reported in failed while the others still apply", async () => {
    const result = await answer(q.failing, "both-done");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.applied).toEqual([{ op: "complete_task", id: ids.statement }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ op: "complete_task", id: ghostTaskId });
    expect(result.failed[0].error).toMatch(/no task/i);
    expect((await taskRow(ids.statement)).status).toBe("done");
    // The question is still resolved: the user answered it.
    expect((await getQuestion(U.id, q.failing))?.status).toBe("resolved");
  });

  it("(6) a remember_fact write creates the memory, and a never-surfaced question is logged as asked and answered now", async () => {
    const result = await answer(q.fact, "yes-last-step");
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [{ op: "remember_fact" }],
      failed: [],
    });
    const stored = await db
      .select({ fact: memories.fact, tags: memories.tags })
      .from(memories)
      .where(and(eq(memories.userId, U.id), eq(memories.fact, "The US Bank statement is the last step of reconciling CPO 2073.")));
    expect(stored).toHaveLength(1);
    expect(stored[0].tags).toEqual(["Caltrans", "answered"]);

    const record = await recordFor(ids.caltrans);
    const asked = record.body.asked.find((a) => a.questionId === q.fact);
    expect(asked?.answer).toBe("Yes, that is the last step");
    expect(asked?.askedAt).toBe(asked?.answeredAt);
    // The earlier entries are untouched: (3) kept its askedAt, (5) was logged too.
    expect(record.body.asked.find((a) => a.questionId === q.close)?.askedAt).toBe(ASKED_AT);
    expect(record.body.asked.find((a) => a.questionId === q.failing)?.answer).toBe("Both done");
    expect(record.body.asked.map((a) => a.questionId)).toEqual([q.close, q.failing, q.fact]);
  });

  it("(7) a clear_expectation write clears the follow-up, scoped to the user", async () => {
    const result = await answer(q.expect, "yes-changed");
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [{ op: "clear_expectation", id: extraExpectationId }],
      failed: [],
    });
    const [row] = await db
      .select({ status: expectations.status, clearedAt: expectations.clearedAt })
      .from(expectations)
      .where(eq(expectations.id, extraExpectationId));
    expect(row.status).toBe("cleared");
    expect(row.clearedAt).not.toBeNull();
  });

  it("(8) the note is kept with the label as the resolution, and a project with no record is fine", async () => {
    const result = await answer(q.note, "keep", "  it is still on  ");
    // The answer itself writes nothing, so the note is also kept as a memory
    // (tests/understanding-interview.test.ts (7)); that is the one applied write.
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.album,
      applied: [{ op: "remember_fact" }],
      failed: [],
    });
    const [stored] = await db
      .select({ status: clarifications.status, resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.note));
    expect(stored).toEqual({ status: "resolved", resolution: "Keep: it is still on" });
    expect(await recordFor(ids.album)).toBeUndefined();
    // No source was given, so the memory is tagged with the project alone:
    // the "interview" tag belongs to answers the Interview sends.
    const rows = await db.select({ fact: memories.fact, tags: memories.tags }).from(memories).where(eq(memories.userId, U.id));
    const kept = rows.find((m) => m.fact.endsWith(": it is still on"));
    expect(kept?.tags).toEqual(["Album"]);
  });

  it("(9) another user's question is not-found, never not-open, and stays open", async () => {
    expect(await answer(q.foreign, "keep")).toEqual({ status: "not-found" });
    const [row] = await db
      .select({ status: clarifications.status, resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.foreign));
    expect(row).toEqual({ status: "open", resolution: null });
  });

  it("(10) a date-only set_due lands on that calendar day in the user's timezone, not the day before", async () => {
    const result = await answer(q.due, "do-it");
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.album,
      applied: [{ op: "set_due", id: t.due }],
      failed: [],
    });
    const task = await taskRow(t.due);
    expect(task.dueAt).not.toBeNull();
    // Oct 10 in Los Angeles, from its first minute: 07:00Z under PDT. Read as
    // UTC midnight it would have been Oct 9, 5:00 PM there.
    expect(localDateInTz(TZ, task.dueAt!)).toBe("2026-10-10");
    expect(task.dueAt!.toISOString()).toBe("2026-10-10T07:00:00.000Z");
    // Moved forward, so the tool counted a postponement — the audit path applies.
    expect(task.postponedCount).toBe(1);
  });

  it("(10b) dueInstantInTz: the user's clock for dates and bare datetimes, pass-through with an offset", () => {
    // Either side of a DST change, midnight is midnight in Los Angeles.
    expect(dueInstantInTz(TZ, "2026-03-08")?.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(dueInstantInTz(TZ, "2026-11-01")?.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    // A datetime with no offset is the user's wall clock, not the server's.
    expect(dueInstantInTz(TZ, "2026-10-10T09:00:00")?.toISOString()).toBe("2026-10-10T16:00:00.000Z");
    // One with an offset already says which instant it means.
    expect(dueInstantInTz(TZ, "2026-10-10T09:00:00+02:00")?.toISOString()).toBe("2026-10-10T07:00:00.000Z");
    expect(dueInstantInTz(TZ, "2026-10-10T09:00:00Z")?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    // A day that does not exist is not quietly the next one.
    expect(dueInstantInTz(TZ, "2026-02-30")).toBeNull();
    expect(dueInstantInTz(TZ, "not a date")).toBeNull();
  });

  it("(11) drop_task, set_recurrence and set_blocked_reason go through update_task", async () => {
    expect(await answer(q.drop, "do-it")).toMatchObject({
      status: "resolved",
      applied: [{ op: "drop_task", id: t.drop }],
      failed: [],
    });
    expect((await taskRow(t.drop)).status).toBe("dropped");

    expect(await answer(q.recur, "do-it")).toMatchObject({
      status: "resolved",
      applied: [{ op: "set_recurrence", id: t.recur }],
      failed: [],
    });
    const recur = await taskRow(t.recur);
    expect(recur.recurrence).toBe("weekly");
    expect(recur.status).toBe("todo");

    expect(await answer(q.block, "do-it")).toMatchObject({
      status: "resolved",
      applied: [{ op: "set_blocked_reason", id: t.block }],
      failed: [],
    });
    const blocked = await taskRow(t.block);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("Waiting on the publisher");
    // The tool's own trail, which is why the write goes through it.
    const trail = await db
      .select({ note: checkins.note })
      .from(checkins)
      .where(and(eq(checkins.userId, U.id), eq(checkins.taskId, t.block)));
    expect(trail.length).toBeGreaterThan(0);
  });

  it("(12) a stored write outside the closed list is a bad answer, refused whole", async () => {
    expect(await answer(q.malformed, "do-it")).toEqual({ status: "bad-answer" });
    expect((await getQuestion(U.id, q.malformed))?.status).toBe("open");
    expect((await taskRow(t.race)).status).toBe("todo");
  });

  it("(13) two answers landing at once: one resolves, the other is not-open, the task is closed once", async () => {
    const [a, b] = await Promise.all([answer(q.race, "do-it"), answer(q.race, "do-it")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["not-open", "resolved"]);
    const won = a.status === "resolved" ? a : b;
    expect(won).toMatchObject({ applied: [{ op: "complete_task", id: t.race }], failed: [] });

    expect((await taskRow(t.race)).status).toBe("done");
    // Exactly one "Marked done": the second answer never reached the tools.
    const trail = await db
      .select({ note: checkins.note })
      .from(checkins)
      .where(and(eq(checkins.userId, U.id), eq(checkins.taskId, t.race)));
    expect(trail.map((c) => c.note)).toEqual(["Marked done"]);
    expect((await getQuestion(U.id, q.race))?.status).toBe("resolved");
  });
});
