// The Caltrans pair end to end, through the public functions — what
// docs/understanding/SPEC.md §5, §6 and §8 promise together: answering a
// question persists the decision, sets aside the questions whose premise it
// changed, keeps them from returning without new evidence, lets them back
// when evidence appears, refuses a second submission, and heals a doubled
// row. Against the local database on one throwaway user seeded with the
// duplicate-CPO scenario and a fake model; no live model, ever.
//
// The steps are a sequence: each asserts on what the previous ones left.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, messages, tasks, understandingRuns, user } from "@/lib/db/schema";
import { answerInOwnWords, answerQuestion } from "@/lib/understanding/answer";
import type { InterpretCall } from "@/lib/understanding/interpret";
import { healDuplicates, questionIdentity } from "@/lib/understanding/questions";
import { runProject, type ModelCall } from "@/lib/understanding/run";
import { sweepUnderstanding } from "@/lib/understanding/sweep";
import { buildToday } from "@/lib/understanding/today";
import { QUESTION_KINDS, type QuestionDraft, type Source } from "@/lib/understanding/types";
import {
  CPO_NOW,
  CPO_TZ,
  fakeModel,
  seedCpoScenario,
  validOutputFor,
  type CpoIds,
} from "./fixtures/understanding";

const U = {
  id: `test-understanding-flow-${crypto.randomUUID()}`,
  email: `understanding-flow-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
let ids: CpoIds;

const task = (id: string): Source => ({ type: "task", id });

/** Q1 as the goal words it; the why quotes the open copy's title so the validator accepts it. */
const q1Draft = (): QuestionDraft => ({
  kind: "doesnt_add_up",
  question: "CPO 2073 is on your list twice. Close the old one?",
  why: `"Process CPO 2073 / Production monitor as an FY 2027 transaction this month" is still open, but the finished copy says the new number is 0394.`,
  evidence: [task(ids.doneCpo), task(ids.blockedCpo), task(ids.checkCpo)],
  answers: [
    {
      id: "close",
      label: "Close the old one",
      writes: [
        { op: "complete_task", taskId: ids.blockedCpo },
        { op: "complete_task", taskId: ids.checkCpo },
        { op: "resolve" },
      ],
    },
    { id: "keep", label: "Keep them", writes: [{ op: "resolve" }] },
  ],
});

/** Q2, resting on the rows Q1's answer changes. */
const q2Draft = (): QuestionDraft => ({
  kind: "need_to_know",
  question: "What is blocking CPO 2073?",
  why: `"Check what is blocking CPO 2073 and report back" is still open, and you said "Nothing is blocked right now on the CPO side".`,
  evidence: [task(ids.blockedCpo), task(ids.checkCpo), { type: "message", id: ids.msgNothingBlocked }],
  answers: [
    {
      id: "nothing",
      label: "Nothing, close it",
      writes: [{ op: "complete_task", taskId: ids.checkCpo }, { op: "resolve" }],
    },
    { id: "other", label: "Something else", writes: [{ op: "resolve" }] },
  ],
});

/** The issue back with a message the ruling never saw. */
const walterDraft = (messageId: string): QuestionDraft => ({
  kind: "need_to_know",
  question: "Is Walter holding CPO 2073?",
  why: `You said "Walter still has CPO 2073 on his desk" after "Check what is blocking CPO 2073 and report back" was closed.`,
  evidence: [task(ids.blockedCpo), task(ids.checkCpo), { type: "message", id: messageId }],
  answers: [
    { id: "yes", label: "Yes, he has it", writes: [{ op: "resolve" }] },
    { id: "no", label: "No", writes: [{ op: "resolve" }] },
  ],
});

/** The Caltrans record as the fixture has it, with these questions in place of its own. */
const withQuestions = (drafts: QuestionDraft[]) =>
  fakeModel((bundle) => ({ ...validOutputFor(bundle, ids), questions: drafts }));

const run = (model: ModelCall) =>
  runProject(U.id, ids.caltrans, { timezone: TZ, now: NOW, model, force: true });

const rowOf = async (id: string) => {
  const [row] = await db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, id)));
  return row;
};

const questionRows = () =>
  db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), inArray(clarifications.kind, [...QUESTION_KINDS])))
    .orderBy(clarifications.createdAt);

const taskRow = async (id: string) => {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, id)));
  return row;
};

/** The ids Today shows, hero first. */
const shownToday = async () => {
  const today = await buildToday(U.id, TZ, NOW);
  return {
    ids: [today.hero, ...today.questions].flatMap((q) => (q ? [q.id] : [])),
    open: today.counts.questions,
  };
};

const latestRunId = async () => {
  const [row] = await db
    .select({ id: understandingRuns.id })
    .from(understandingRuns)
    .where(
      and(
        eq(understandingRuns.userId, U.id),
        eq(understandingRuns.projectId, ids.caltrans),
        eq(understandingRuns.status, "ok")
      )
    )
    .orderBy(desc(understandingRuns.startedAt))
    .limit(1);
  return row?.id ?? null;
};

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Flow Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("the Caltrans pair, end to end", () => {
  let q1 = "";
  let q2 = "";
  let walter = "";
  let firstRunId = "";
  let newMessageId = "";
  const completedAt: Record<string, string> = {};

  it("(1) a run creates Q1 and Q2, each pointing at the run that made it", async () => {
    const model = withQuestions([q1Draft(), q2Draft()]);
    const result = await run(model);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.questions.created).toHaveLength(2);
    expect(result.questions.reopened).toEqual([]);
    expect(result.questions.skippedSettled).toEqual([]);

    const rows = await questionRows();
    const one = rows.find((r) => r.identity === questionIdentity(q1Draft()))!;
    const two = rows.find((r) => r.identity === questionIdentity(q2Draft()))!;
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    q1 = one.id;
    q2 = two.id;
    expect(one).toMatchObject({ status: "open", resolvedAt: null, supersededBy: null });
    expect(two).toMatchObject({ status: "open", resolvedAt: null, supersededBy: null });

    firstRunId = (await latestRunId())!;
    expect(firstRunId).toBeTruthy();
    expect(one.createdByRun).toBe(firstRunId);
    expect(two.createdByRun).toBe(firstRunId);
  });

  it("(2) Today shows both", async () => {
    const today = await shownToday();
    expect(today.ids.sort()).toEqual([q1, q2].sort());
    expect(today.open).toBe(2);
  });

  it("(3) answering Q1 closes the old copy, resolves Q1 and sets Q2 aside in the same moment", async () => {
    const result = await answerQuestion(U.id, TZ, q1, "close", undefined, "today");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.projectId).toBe(ids.caltrans);
    expect(result.applied).toEqual([
      { op: "complete_task", id: ids.blockedCpo },
      { op: "complete_task", id: ids.checkCpo },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.superseded).toEqual([q2]);

    const one = await rowOf(q1);
    expect(one.status).toBe("resolved");
    expect(one.resolution).toBe("Close the old one");
    expect(one.resolvedAt).not.toBeNull();
    expect(one.supersededBy).toBeNull();

    const two = await rowOf(q2);
    expect(two.status).toBe("superseded");
    expect(two.supersededBy).toBe(q1);
    expect(two.resolution).toBe("premise changed by an answer");
    expect(two.resolvedAt?.toISOString()).toBe(one.resolvedAt?.toISOString());

    for (const id of [ids.blockedCpo, ids.checkCpo]) {
      const t = await taskRow(id);
      expect(t.status).toBe("done");
      expect(t.completedAt).not.toBeNull();
      completedAt[id] = t.completedAt!.toISOString();
      // The answer's own writes are never "a row changed after the ruling".
      expect(t.updatedAt.getTime()).toBeLessThanOrEqual(one.resolvedAt!.getTime());
    }
  });

  it("(4) a reload shows neither, and nothing waits behind them", async () => {
    const today = await shownToday();
    expect(today.ids).not.toContain(q1);
    expect(today.ids).not.toContain(q2);
    expect(today.open).toBe(0);
  });

  it("(5) a re-run that re-emits Q2, or the same issue in new words on the same rows, creates nothing", async () => {
    const reworded: QuestionDraft = {
      ...q2Draft(),
      question: "Is anything still blocking CPO 2073?",
      why: `"Check what is blocking CPO 2073 and report back" is closed now.`,
      evidence: [task(ids.blockedCpo), task(ids.checkCpo)],
    };
    expect(questionIdentity(reworded)).not.toBe(questionIdentity(q2Draft()));

    const model = withQuestions([q2Draft(), reworded]);
    const result = await run(model);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.questions).toEqual({
      created: [],
      updated: [],
      dismissed: [],
      skippedDuplicates: [],
      skippedSettled: [q2Draft().question, reworded.question],
      reopened: [],
    });
    expect((await questionRows()).map((r) => r.id).sort()).toEqual([q1, q2].sort());
    expect((await rowOf(q2)).status).toBe("superseded");
    expect((await shownToday()).open).toBe(0);
  });

  it("(6) a message the ruling never saw is new evidence: the issue comes back as a new question", async () => {
    const [msg] = await db
      .insert(messages)
      .values({
        userId: U.id,
        conversationId: ids.conversation,
        role: "user",
        mode: "voice",
        content: "Walter still has CPO 2073 on his desk",
        createdAt: new Date(NOW.getTime() + 60_000),
      })
      .returning({ id: messages.id });
    newMessageId = msg.id;

    const model = withQuestions([walterDraft(newMessageId)]);
    const result = await run(model);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(model.calls[0].bundle.messages.map((m) => m.id)).toContain(newMessageId);
    expect(result.questions.created).toHaveLength(1);
    expect(result.questions.skippedSettled).toEqual([]);
    expect(result.questions.reopened).toEqual([]);
    walter = result.questions.created[0];

    const row = await rowOf(walter);
    expect(row.status).toBe("open");
    expect(row.createdByRun).toBe(await latestRunId());
    expect(row.createdByRun).not.toBe(firstRunId);
    expect((await shownToday()).ids).toEqual([walter]);
  });

  it("(7) a row edited after the ruling is new evidence: Q2's identity reopens as a new row", async () => {
    const edited = new Date(Date.now() + 60_000);
    await db
      .update(tasks)
      .set({ updatedAt: edited })
      .where(and(eq(tasks.userId, U.id), eq(tasks.id, ids.blockedCpo)));

    const model = withQuestions([q2Draft(), walterDraft(newMessageId)]);
    const result = await run(model);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.questions.reopened).toHaveLength(1);
    expect(result.questions).toMatchObject({
      created: [],
      updated: [walter],
      dismissed: [],
      skippedDuplicates: [],
      skippedSettled: [],
    });
    const reopened = result.questions.reopened[0];

    // A new row with Q2's identity; the superseded one stays as the record of the ruling.
    const same = (await questionRows()).filter((r) => r.identity === questionIdentity(q2Draft()));
    expect(same.map((r) => r.id).sort()).toEqual([q2, reopened].sort());
    expect(await rowOf(reopened)).toMatchObject({
      status: "open",
      resolvedAt: null,
      supersededBy: null,
      createdByRun: await latestRunId(),
    });
    expect((await rowOf(q2)).status).toBe("superseded");
    expect((await shownToday()).ids.sort()).toEqual([walter, reopened].sort());
  });

  it("(8) answering Q1 again is refused and changes nothing", async () => {
    expect(await answerQuestion(U.id, TZ, q1, "close")).toEqual({ status: "not-open" });
    for (const id of [ids.blockedCpo, ids.checkCpo]) {
      expect((await taskRow(id)).completedAt?.toISOString()).toBe(completedAt[id]);
    }
    expect((await rowOf(q1)).status).toBe("resolved");
  });

  it("(9) the same answer typed in the user's own words sets the related question aside the same way", async () => {
    // A second pair, on the Album, so the writes here touch nothing above.
    const [mix] = await db
      .insert(tasks)
      .values({ userId: U.id, projectId: ids.album, title: "Send the weekly mix to the band", status: "todo" })
      .returning({ id: tasks.id });
    const base = { userId: U.id, projectId: ids.album, rank: 100, status: "open" as const, context: "why" };
    const [three, four] = await db
      .insert(clarifications)
      .values([
        {
          ...base,
          kind: "done_yet",
          question: "Did the weekly mix go out?",
          identity: "flow-q3",
          evidence: [task(mix.id)],
          answers: [
            {
              id: "close",
              label: "Yes, close it",
              writes: [{ op: "complete_task", taskId: mix.id }, { op: "resolve" }],
            },
            { id: "no", label: "Not yet", writes: [{ op: "resolve" }] },
          ],
        },
        {
          ...base,
          kind: "need_to_know",
          question: "Does the band get the mix before the master?",
          identity: "flow-q4",
          evidence: [task(mix.id), task(ids.albumOverdue)],
          answers: [{ id: "keep", label: "Keep it", writes: [{ op: "resolve" }] }],
        },
      ])
      .returning({ id: clarifications.id });

    const call: InterpretCall = async () => ({
      output: { answerId: "close", fact: null, reply: "You want it closed." },
      model: "fake-interpret",
      inputTokens: 5,
      outputTokens: 3,
    });
    const words = "yes, it went out, close it";
    const result = await answerInOwnWords(U.id, TZ, three.id, words, "today", call);
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.album,
      applied: [{ op: "complete_task", id: mix.id }],
      failed: [],
      superseded: [four.id],
      reply: "You want it closed.",
    });

    const q3 = await rowOf(three.id);
    expect(q3.status).toBe("resolved");
    expect(q3.resolution).toBe(`Yes, close it: ${words}`);
    expect(q3.resolvedAt).not.toBeNull();
    const q4 = await rowOf(four.id);
    expect(q4.status).toBe("superseded");
    expect(q4.supersededBy).toBe(three.id);
    expect(q4.resolvedAt?.toISOString()).toBe(q3.resolvedAt?.toISOString());
    expect((await taskRow(mix.id)).status).toBe("done");

    // Typed again: refused before the words are read.
    expect(await answerInOwnWords(U.id, TZ, three.id, words, "today", call)).toEqual({ status: "not-open" });
  });

  it("(10) healDuplicates keeps the oldest of a same-text pair and dismisses the twin; the sweep runs it with no model", async () => {
    const t0 = new Date(NOW.getTime() - 3_600_000);
    const twin = (identity: string, createdAt: Date, evidence: Source[]) => ({
      userId: U.id,
      projectId: ids.album,
      rank: 200,
      status: "open" as const,
      kind: "doesnt_add_up" as const,
      question: "Do you still want my two event prep suggestions?",
      context: "why",
      identity,
      evidence,
      answers: [{ id: "keep", label: "Keep them", writes: [{ op: "resolve" as const }] }],
      createdAt,
    });
    const [older, newer] = await db
      .insert(clarifications)
      .values([
        twin("flow-twin-a", t0, [task(ids.albumOverdue)]),
        twin("flow-twin-b", new Date(t0.getTime() + 1000), [{ type: "event", id: ids.eventDentist }]),
      ])
      .returning({ id: clarifications.id });

    expect(await healDuplicates(U.id, NOW)).toEqual([newer.id]);
    expect(await rowOf(older.id)).toMatchObject({ status: "open", resolution: null, resolvedAt: null });
    const twinRow = await rowOf(newer.id);
    expect(twinRow).toMatchObject({ status: "dismissed", resolution: `duplicate of ${older.id}` });
    expect(twinRow.resolvedAt?.toISOString()).toBe(NOW.toISOString());
    // Safe to run again: the pair is one row now.
    expect(await healDuplicates(U.id, NOW)).toEqual([]);

    // The sweep heals before it looks for a model, so a keyless deployment
    // (none under vitest) still cleans a doubled row.
    const [third] = await db
      .insert(clarifications)
      .values(twin("flow-twin-c", new Date(t0.getTime() + 2000), [task(ids.albumOverdue), { type: "event", id: ids.eventDentist }]))
      .returning({ id: clarifications.id });
    const swept = await sweepUnderstanding({ now: NOW, userIds: [U.id] });
    expect(swept).toEqual({ users: 1, ran: 0, skipped: 0, failed: 0, retiredAsr: 0, healed: 1 });
    expect(await rowOf(third.id)).toMatchObject({ status: "dismissed", resolution: `duplicate of ${older.id}` });
    expect((await rowOf(older.id)).status).toBe("open");
  });
});
