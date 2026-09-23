// The event-driven half of the clarification flow (lib/understanding/supersede.ts):
// an answer's writes make other pending questions obsolete at once, and a
// ruled-on issue does not come back in new words unless a row it rests on
// changed or new evidence appeared.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, user } from "@/lib/db/schema";
import {
  changedRowsOf,
  isAlreadyRuledOn,
  settledEvidence,
  supersedeByWrites,
} from "@/lib/understanding/supersede";
import type { Answer, Source, Write } from "@/lib/understanding/types";
import { CPO_NOW, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = { id: `test-supersede-${crypto.randomUUID()}`, email: `supersede-${Date.now()}@p11.test` };
const NOW = new Date(CPO_NOW.getTime() + 60_000);
let ids: CpoIds;
let q1 = "";
let q2 = "";
let q3 = "";

const task = (id: string): Source => ({ type: "task", id });

async function insertQuestion(input: {
  kind: "need_to_know" | "doesnt_add_up" | "done_yet";
  question: string;
  evidence: Source[];
  answers: Answer[];
  identity: string;
}): Promise<string> {
  const [row] = await db
    .insert(clarifications)
    .values({
      userId: U.id,
      projectId: ids.caltrans,
      kind: input.kind,
      question: input.question,
      context: "why",
      evidence: input.evidence,
      answers: input.answers,
      identity: input.identity,
      status: "open",
    })
    .returning({ id: clarifications.id });
  return row.id;
}

const rowOf = async (id: string) =>
  (await db.select().from(clarifications).where(and(eq(clarifications.userId, U.id), eq(clarifications.id, id))))[0];

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Supersede Tester", email: U.email, timezone: "America/Los_Angeles" });
  ids = await seedCpoScenario(U.id);
  // The Caltrans pair the goal names: closing the old 2073 copy (Q1) makes
  // "what is blocking 2073" (Q2) a question about a premise that is gone.
  q1 = await insertQuestion({
    kind: "doesnt_add_up",
    question: "CPO 2073 is on your list twice. Close the old one?",
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
    identity: "id-q1",
  });
  q2 = await insertQuestion({
    kind: "need_to_know",
    question: "What is blocking CPO 2073?",
    evidence: [task(ids.blockedCpo), task(ids.checkCpo), { type: "message", id: ids.msgNothingBlocked }],
    answers: [
      { id: "nothing", label: "Nothing, close it", writes: [{ op: "complete_task", taskId: ids.checkCpo }, { op: "resolve" }] },
      { id: "other", label: "Something else", writes: [{ op: "resolve" }] },
    ],
    identity: "id-q2",
  });
  q3 = await insertQuestion({
    kind: "need_to_know",
    question: "Which CPO are you paying for next?",
    evidence: [task(ids.statement), { type: "memory", id: ids.memMonthly }],
    answers: [{ id: "later", label: "Ask me tomorrow", writes: [{ op: "resolve" }] }],
    identity: "id-q3",
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("changedRowsOf", () => {
  it("names each task or expectation a list of writes touches, once", () => {
    const writes: Write[] = [
      { op: "complete_task", taskId: "t1" },
      { op: "set_due", taskId: "t1", dueAt: "2026-10-01" },
      { op: "clear_expectation", expectationId: "e1" },
      { op: "remember_fact", fact: "x", tags: [] },
      { op: "resolve" },
    ];
    expect(changedRowsOf(writes)).toEqual([
      { type: "task", id: "t1" },
      { type: "expectation", id: "e1" },
    ]);
  });
});

describe("an answer supersedes the questions that rested on what it changed", () => {
  it("marks the blocker question superseded the moment the old copy is closed, and leaves the rest", async () => {
    const closeIt = (await rowOf(q1)).answers.find((a) => a.id === "close")!;
    const hit = await supersedeByWrites(db, U.id, q1, changedRowsOf(closeIt.writes), NOW);
    expect(hit).toEqual([q2]);

    const second = await rowOf(q2);
    expect(second.status).toBe("superseded");
    expect(second.supersededBy).toBe(q1);
    expect(second.resolvedAt?.toISOString()).toBe(NOW.toISOString());

    // The answered question itself and an unrelated one are untouched.
    expect((await rowOf(q1)).status).toBe("open");
    expect((await rowOf(q3)).status).toBe("open");
  });

  it("is safe to run again: nothing pending rests on those rows any more", async () => {
    const closeIt = (await rowOf(q1)).answers.find((a) => a.id === "close")!;
    expect(await supersedeByWrites(db, U.id, q1, changedRowsOf(closeIt.writes), NOW)).toEqual([]);
  });

  it("does nothing for writes that change no row", async () => {
    expect(await supersedeByWrites(db, U.id, q3, changedRowsOf([{ op: "resolve" }]), NOW)).toEqual([]);
  });
});

describe("a ruled-on issue does not return without new evidence", () => {
  it("settledEvidence carries every row of a closed question with the moment it closed", async () => {
    // Q1 is answered now; Q2 was superseded above.
    await db
      .update(clarifications)
      .set({ status: "resolved", resolution: "Close the old one", resolvedAt: NOW })
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, q1)));
    const settled = await settledEvidence(db, U.id, NOW);
    expect(settled.get(`task:${ids.blockedCpo}`)?.toISOString()).toBe(NOW.toISOString());
    expect(settled.get(`task:${ids.checkCpo}`)?.toISOString()).toBe(NOW.toISOString());
    expect(settled.get(`message:${ids.msgNothingBlocked}`)).toBeDefined();
    // Q3 is still open: its rows are not settled.
    expect(settled.has(`task:${ids.statement}`)).toBe(false);
  });

  it("the same issue on the same unchanged rows is already ruled on", async () => {
    const settled = await settledEvidence(db, U.id, NOW);
    const before = new Date(NOW.getTime() - 3_600_000);
    const draft = [task(ids.blockedCpo), task(ids.checkCpo)];
    expect(isAlreadyRuledOn(draft, settled, () => before)).toBe(true);
  });

  it("a row edited after the ruling is new evidence", async () => {
    const settled = await settledEvidence(db, U.id, NOW);
    const after = new Date(NOW.getTime() + 3_600_000);
    const draft = [task(ids.blockedCpo), task(ids.checkCpo)];
    expect(isAlreadyRuledOn(draft, settled, (key) => (key === `task:${ids.blockedCpo}` ? after : null))).toBe(false);
  });

  it("a message the ruling never saw is new evidence, and an unsettled row is not ruled on", async () => {
    const settled = await settledEvidence(db, U.id, NOW);
    expect(isAlreadyRuledOn([task(ids.blockedCpo), { type: "message", id: ids.msgCpo }], settled, () => null)).toBe(false);
    expect(isAlreadyRuledOn([task(ids.statement)], settled, () => null)).toBe(false);
    expect(isAlreadyRuledOn([], settled, () => null)).toBe(false);
  });
});
