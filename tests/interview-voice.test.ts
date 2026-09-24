// The Interview, spoken (lib/secretary/interview-voice.ts; docs/understanding
// SPEC §6 "Voice", §9 "Interview"), against the local database on one
// throwaway user with three questions inserted by hand.
//
// What is asserted: the interview block carries the queue in the Interview
// tab's order with the ids answer_question needs, and marks only the first as
// asked; an interview briefing drops OPEN QUESTIONS and the clarification
// queue (the block is the call's questions); answer_question, on an interview
// call, returns the next question in the same result (skipped ones wrap
// round at the end), and on an ordinary call returns no such thing.
// No model is involved: the answers are listed ones, and the re-run after an
// answer skips under vitest.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import {
  interviewInstructions,
  interviewSessionBlock,
  questionLine,
} from "@/lib/secretary/interview-voice";
import { executeTool } from "@/lib/secretary/tools";
import { listQuestions } from "@/lib/understanding/questions";
import { CPO_NOW, CPO_TZ, seedCpoScenario } from "./fixtures/understanding";

const U = {
  id: `test-interview-voice-${crypto.randomUUID()}`,
  email: `interview-voice-${Date.now()}@p11.test`,
};
const ctx = { userId: U.id, timezone: CPO_TZ };
const interviewCtx = { ...ctx, surface: "interview" as const };
const q = { first: "", second: "", third: "" };

const row = async (id: string) => {
  const [r] = await db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, id)));
  return r;
};

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Interview Voice Tester", email: U.email, timezone: CPO_TZ });
  const ids = await seedCpoScenario(U.id, CPO_NOW);
  const base = { userId: U.id, status: "open" as const, kind: "need_to_know" as const, projectId: ids.caltrans };
  const answers = [
    { id: "yes", label: "Yes, that's it", writes: [{ op: "resolve" as const }] },
    { id: "no", label: "No", writes: [{ op: "resolve" as const }] },
  ];
  const inserted = await db
    .insert(clarifications)
    .values([
      { ...base, rank: 0, identity: "iv-1", question: "Is the statement the last step?", context: "Due tomorrow.", answers },
      { ...base, rank: 1, identity: "iv-2", question: "Is beacon glue paid?", context: "No CPO number yet.", answers },
      { ...base, rank: 2, identity: "iv-3", question: "Is 0394 reconciled?", context: "Two copies.", answers },
    ])
    .returning({ id: clarifications.id });
  [q.first, q.second, q.third] = inserted.map((r) => r.id);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await db.delete(user).where(eq(user.id, U.id));
});

describe("the interview block", () => {
  it("says there is nothing to ask when the queue is empty", () => {
    const text = interviewInstructions([]);
    expect(text).toContain("INTERVIEW MODE");
    expect(text).toContain("Nothing open to ask right now.");
    expect(text).not.toContain("QUEUE");
  });

  it("carries the queue in the Interview tab's order, and marks only the first as asked", async () => {
    const text = await interviewSessionBlock(U.id, { now: CPO_NOW });
    expect(text).toContain("Open with the FIRST question below");
    expect(text).toContain('say at most "One sec."');
    expect(text).toContain("answer_question");
    expect(text).toContain("own_words");
    expect(text).toContain("next_question");
    const lines = text.split("\n").filter((l) => l.startsWith("- question_id: "));
    const order = (await listQuestions(U.id)).map((r) => r.id);
    expect(order).toEqual([q.first, q.second, q.third]);
    expect(lines.map((l) => l.split(" · ")[0].slice("- question_id: ".length))).toEqual(order);
    expect(lines[0]).toContain("answers: yes=Yes, that's it; no=No");
    expect((await row(q.first)).surfacedAt).not.toBeNull();
    expect((await row(q.second)).surfacedAt).toBeNull();
  });

  it("a resumed call does not restart and marks nothing new", async () => {
    const text = await interviewSessionBlock(U.id, { reconnect: true });
    expect(text).toContain("resuming after a reconnect");
    expect((await row(q.second)).surfacedAt).toBeNull();
  });

  it("an interview briefing carries neither OPEN QUESTIONS nor the clarification queue", async () => {
    const { text } = await buildBriefing(U.id, CPO_TZ, { questions: false });
    expect(text).not.toContain("OPEN QUESTIONS");
    expect(text).not.toContain("CLARIFICATION QUEUE");
    expect((await row(q.second)).surfacedAt).toBeNull();
  });
});

describe("answer_question on an interview call", () => {
  it("an ordinary call gets no next_question", async () => {
    const { result } = await executeTool(ctx, "answer_question", { question_id: "no-such", answer_id: "yes" });
    expect(result).not.toHaveProperty("next_question");
  });

  it("returns what was applied and the next question, marked asked, in one result", async () => {
    const { result } = await executeTool(interviewCtx, "answer_question", {
      question_id: q.first,
      answer_id: "yes",
    });
    const r = result as { status?: string; next_question?: string | null; questions_left?: number };
    expect(r.status).toBe("resolved");
    expect(r.next_question).toBe(questionLine((await listQuestions(U.id))[0]));
    expect(r.next_question).toContain(`question_id: ${q.second}`);
    expect(r.questions_left).toBe(2);
    expect((await row(q.second)).surfacedAt).not.toBeNull();
  });

  it("a skipped question comes back at the end: answering the third wraps round to the second", async () => {
    const { result } = await executeTool(interviewCtx, "answer_question", {
      question_id: q.third,
      answer_id: "no",
    });
    const r = result as { next_question?: string | null; questions_left?: number };
    expect(r.next_question).toContain(`question_id: ${q.second}`);
    expect(r.questions_left).toBe(1);
  });

  it("an already-answered question still moves on", async () => {
    const { result } = await executeTool(interviewCtx, "answer_question", {
      question_id: q.first,
      answer_id: "no",
    });
    const r = result as { error?: string; next_question?: string | null };
    expect(r.error).toContain("already answered");
    expect(r.next_question).toContain(`question_id: ${q.second}`);
  });

  it("the last answer says there is nothing more: next_question is null", async () => {
    const { result } = await executeTool(interviewCtx, "answer_question", {
      question_id: q.second,
      answer_id: "yes",
    });
    const r = result as { status?: string; next_question?: string | null; questions_left?: number };
    expect(r.status).toBe("resolved");
    expect(r.next_question).toBeNull();
    expect(r.questions_left).toBe(0);
  });
});
