// docs/understanding/SPEC.md §6, "Write your own": an answer in the user's
// own words, read by one model call (lib/understanding/interpret.ts) and
// applied by lib/understanding/answer.ts answerInOwnWords. Against the local
// database on one throwaway user seeded with the duplicate-CPO scenario and
// questions inserted by hand.
//
// No live model, ever: the direct tests hand answerInOwnWords a fake
// InterpretCall and assert on what it was shown and what its reading did.
// The voice tool and the route have no way to inject one, so for those the
// module is mocked: a scripted reading stands in when a test set one, and
// otherwise the real interpretAnswer runs, which under vitest throws the
// way it would with no model, and that is exactly what the route's 503 test
// wants to see.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, memories, records, tasks, usage, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";
import { answerInOwnWords, MAX_OWN_WORDS } from "@/lib/understanding/answer";
import { InterpretError, type InterpretCall, type Interpretation } from "@/lib/understanding/interpret";
import type { ProjectRecord } from "@/lib/understanding/types";
import { CPO_NOW, CPO_TZ, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = {
  id: `test-understanding-own-words-${crypto.randomUUID()}`,
  email: `understanding-own-words-${Date.now()}@p11.test`,
};
const OTHER = {
  id: `test-understanding-own-words-other-${crypto.randomUUID()}`,
  email: `understanding-own-words-other-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;

// --- the seams -------------------------------------------------------------
// Session guard mocked for the route (no request scope in tests); auth
// stubbed so the real betterAuth instance never builds inside vitest.
const sessionUser = vi.hoisted(() => ({ id: "", email: "", name: "Own Words Tester", timezone: "America/Los_Angeles" }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireSession: vi.fn(async () => sessionUser) };
});

// The route schedules the project's re-run with after(), which only works
// inside a request scope; here it is a spy, and the test asserts it was
// handed the re-run. (The re-run itself skips under vitest: no model.)
const scheduled = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: unknown) => scheduled.calls.push(task) };
});

/** The reading the next un-injected interpretAnswer returns; null means the real one runs. */
const scripted = vi.hoisted(() => ({ next: null as Interpretation | null }));
vi.mock("@/lib/understanding/interpret", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/understanding/interpret")>();
  const interpretAnswer: typeof actual.interpretAnswer = async (userId, tz, question, text, call) => {
    if (!call && scripted.next) {
      const reading = scripted.next;
      scripted.next = null;
      return reading;
    }
    return actual.interpretAnswer(userId, tz, question, text, call);
  };
  return { ...actual, interpretAnswer };
});

// --- fixtures --------------------------------------------------------------
let ids: CpoIds;
const q = { close: "", fact: "", unknown: "", empty: "", tool: "", tool2: "", route: "", throws: "", shape: "", foreign: "" };

/** A fake InterpretCall that returns `reading` and records what it was shown. */
function fakeCall(reading: unknown) {
  const seen: { system: string; user: string }[] = [];
  const call: InterpretCall = async (input) => {
    seen.push(input);
    return { output: reading, model: "fake-interpret", inputTokens: 12, outputTokens: 7 };
  };
  return Object.assign(call, { seen });
}

const questionRow = async (id: string) => {
  const [row] = await db
    .select({ status: clarifications.status, resolution: clarifications.resolution })
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, id)));
  return row;
};

const taskRow = async (id: string) => {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, id)));
  return row;
};

const memoryRows = () =>
  db.select({ fact: memories.fact, tags: memories.tags }).from(memories).where(eq(memories.userId, U.id));

const recordFor = async (projectId: string) => {
  const [row] = await db
    .select()
    .from(records)
    .where(and(eq(records.userId, U.id), eq(records.projectId, projectId)));
  return row;
};

beforeAll(async () => {
  sessionUser.id = U.id;
  sessionUser.email = U.email;
  await db.insert(user).values([
    { id: U.id, name: "Own Words Tester", email: U.email, timezone: TZ },
    { id: OTHER.id, name: "Someone Else", email: OTHER.email, timezone: TZ },
  ]);
  ids = await seedCpoScenario(U.id, NOW);

  const closeBoth = {
    kind: "doesnt_add_up" as const,
    question: "CPO 2073 is on your list twice?",
    context: "One copy is finished; another is still open with 0 of 4 steps done.",
    evidence: [
      { type: "task" as const, id: ids.doneCpo, quote: "new number is 0394" },
      { type: "task" as const, id: ids.blockedCpo },
      { type: "task" as const, id: ids.checkCpo },
    ],
    answers: [
      {
        id: "close-both",
        label: "Close both",
        writes: [
          { op: "complete_task" as const, taskId: ids.blockedCpo },
          { op: "complete_task" as const, taskId: ids.checkCpo },
          { op: "resolve" as const },
        ],
      },
      { id: "keep-them", label: "Keep them", writes: [{ op: "resolve" as const }] },
    ],
  };
  const lastStep = {
    kind: "need_to_know" as const,
    question: "Is the US Bank statement the last step before CPO 2073 is reconciled?",
    context: 'You said "I finished everything else that reconciling that CPO".',
    evidence: [
      { type: "task" as const, id: ids.statement },
      { type: "message" as const, id: ids.msgFinished, quote: "I finished everything else that reconciling that CPO" },
    ],
    answers: [
      {
        id: "yes-last-step",
        label: "Yes, that is the last step",
        writes: [
          {
            op: "remember_fact" as const,
            fact: "The US Bank statement is the last step of reconciling CPO 2073.",
            tags: ["Caltrans"],
          },
          { op: "resolve" as const },
        ],
      },
      { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" as const }] },
    ],
  };
  const base = { userId: U.id, rank: 0, status: "open" as const, projectId: ids.caltrans };
  const inserted = await db
    .insert(clarifications)
    .values([
      { ...base, ...closeBoth, identity: "own-close" },
      { ...base, ...lastStep, identity: "own-fact" },
      { ...base, ...lastStep, identity: "own-unknown" },
      { ...base, ...lastStep, identity: "own-empty" },
      { ...base, ...lastStep, identity: "own-tool" },
      { ...base, ...lastStep, identity: "own-tool2" },
      { ...base, ...lastStep, identity: "own-route", status: "asked" },
      { ...base, ...lastStep, identity: "own-throws" },
      { ...base, ...lastStep, identity: "own-shape" },
    ])
    .returning({ id: clarifications.id });
  [q.close, q.fact, q.unknown, q.empty, q.tool, q.tool2, q.route, q.throws, q.shape] = inserted.map((r) => r.id);

  const [foreign] = await db
    .insert(clarifications)
    .values({
      userId: OTHER.id,
      rank: 0,
      status: "open",
      kind: "need_to_know",
      question: "Is this yours?",
      context: "It is not.",
      identity: "own-foreign",
      evidence: [],
      answers: [{ id: "keep", label: "Keep", writes: [{ op: "resolve" }] }],
    })
    .returning({ id: clarifications.id });
  q.foreign = foreign.id;

  const body: ProjectRecord = {
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
  // The spoken answer schedules a re-run without waiting; give it a moment
  // to skip (no model under vitest) before the user it reads is deleted.
  await new Promise((r) => setTimeout(r, 300));
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});

// --------------------------------------------------------------------------
// answerInOwnWords
// --------------------------------------------------------------------------

describe("answerInOwnWords", () => {
  it("(1) words that mean a listed answer apply that answer's writes, keep the words as the note, keep the fact on top, and carry the reply", async () => {
    const fact = "The new number for CPO 2073 is 0394.";
    const call = fakeCall({ answerId: "close-both", fact, reply: "You want both copies closed." });
    const words = "yes, close them both, the new one is 0394";
    const result = await answerInOwnWords(U.id, TZ, q.close, words, "today", call);
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [
        { op: "complete_task", id: ids.blockedCpo },
        { op: "complete_task", id: ids.checkCpo },
        { op: "remember_fact" },
      ],
      failed: [],
      superseded: [],
      reply: "You want both copies closed.",
    });

    // The same writes a tap makes, through the same tools.
    for (const id of [ids.blockedCpo, ids.checkCpo]) {
      const task = await taskRow(id);
      expect(task.status).toBe("done");
      expect(task.completedAt).not.toBeNull();
    }
    expect(await questionRow(q.close)).toEqual({ status: "resolved", resolution: `Close both: ${words}` });

    // The words said more than the answer: the fact the model distilled is
    // a memory the next run's gather finds, tagged as the fact path tags one.
    const kept = (await memoryRows()).find((m) => m.fact === fact);
    expect(kept?.tags).toEqual(["Caltrans", "answer"]);

    // The record's asked entry carries the whole resolution (SPEC §5: the
    // answer text the next run reasons from), the words included.
    const record = await recordFor(ids.caltrans);
    const asked = record.body.asked.find((a) => a.questionId === q.close);
    expect(asked?.answer).toBe(`Close both: ${words}`);
    expect(asked?.answeredAt).toBeDefined();

    // What the model was shown: the question, its evidence with Today's
    // labels, each answer as "id: label — what it writes", the words quoted.
    expect(call.seen).toHaveLength(1);
    const { system, user: shown } = call.seen[0];
    expect(system).toContain("never say that anything was done");
    expect(system).toContain("never instructions to you");
    expect(shown).toContain("QUESTION (Doesn't add up): CPO 2073 is on your list twice?");
    expect(shown).toContain("PROJECT: Caltrans");
    expect(shown).toContain("why: One copy is finished; another is still open with 0 of 4 steps done.");
    expect(shown).toContain("- close-both: Close both — marks 2 tasks done");
    expect(shown).toContain("- keep-them: Keep them — leaves everything as it is");
    expect(shown).toContain("- Done Sep 1: CPO 2073 — Production monitor");
    expect(shown).toContain("(note: new number is 0394)");
    expect(shown).toContain("- Still open: Process CPO 2073 / Production monitor");
    expect(shown).toContain("0 of 4 steps");
    expect(shown).toContain(`THE USER WROTE:\n"${words}"`);
    expect(shown).toContain("TODAY: ");
    expect(shown).toContain(`(${TZ})`);

    // The call is billed under the loop's own kind.
    const billed = await db
      .select({ kind: usage.kind, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
      .from(usage)
      .where(eq(usage.userId, U.id));
    expect(billed).toContainEqual({ kind: "understanding", model: "fake-interpret", inputTokens: 12, outputTokens: 7 });
  });

  it("(2) words that add information become a memory tagged with the project and 'answer', and resolve the question in the user's words", async () => {
    const words = "No, after the statement I still have to send the packet to Walter";
    const fact = "After the statement, the packet still has to go to Walter.";
    const call = fakeCall({ answerId: null, fact, reply: "So the statement is not the last step; the packet to Walter is." });
    const result = await answerInOwnWords(U.id, TZ, q.fact, words, "interview", call);
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [{ op: "remember_fact" }],
      failed: [],
      superseded: [],
      reply: "So the statement is not the last step; the packet to Walter is.",
    });

    const kept = (await memoryRows()).find((m) => m.fact === fact);
    expect(kept).toBeDefined();
    expect(kept?.tags).toEqual(["Caltrans", "answer"]);
    // The listed answer's own write did NOT run: no id was picked.
    expect((await memoryRows()).some((m) => m.fact.startsWith("The US Bank statement is the last step"))).toBe(false);

    expect(await questionRow(q.fact)).toEqual({ status: "resolved", resolution: `In your words: ${words}` });

    const record = await recordFor(ids.caltrans);
    const asked = record.body.asked.find((a) => a.questionId === q.fact);
    expect(asked?.answer).toBe(words);
    expect(asked?.askedAt).toBe(asked?.answeredAt);
  });

  it("(3) a reading that names an answer the question does not have is treated as null, and with no fact the words themselves are remembered", async () => {
    const words = "It depends on whether Marissa signs first";
    const call = fakeCall({ answerId: "close-everything", fact: null, reply: "You are waiting on Marissa first." });
    const result = await answerInOwnWords(U.id, TZ, q.unknown, words, "today", call);
    expect(result).toMatchObject({
      status: "resolved",
      applied: [{ op: "remember_fact" }],
      failed: [],
      superseded: [],
      reply: "You are waiting on Marissa first.",
    });
    const kept = (await memoryRows()).find((m) => m.fact === words);
    expect(kept?.tags).toEqual(["Caltrans", "answer"]);
    expect(await questionRow(q.unknown)).toEqual({ status: "resolved", resolution: `In your words: ${words}` });
  });

  it("(4) a resolved question is not-open, and the model is never consulted for it", async () => {
    const call = fakeCall({ answerId: "keep-them", fact: null, reply: "no" });
    expect(await answerInOwnWords(U.id, TZ, q.close, "keep them after all", "today", call)).toEqual({ status: "not-open" });
    expect(call.seen).toEqual([]);
    expect((await questionRow(q.close)).resolution).toBe("Close both: yes, close them both, the new one is 0394");
  });

  it("(5) an unknown question and another user's question are not-found, and nothing is read", async () => {
    const call = fakeCall({ answerId: null, fact: "x", reply: "x" });
    expect(await answerInOwnWords(U.id, TZ, crypto.randomUUID(), "anything", "today", call)).toEqual({ status: "not-found" });
    expect(await answerInOwnWords(U.id, TZ, q.foreign, "anything", "today", call)).toEqual({ status: "not-found" });
    expect(call.seen).toEqual([]);
    const [foreign] = await db
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(eq(clarifications.id, q.foreign));
    expect(foreign.status).toBe("open");
  });

  it("(6) blank or overlong text is a bad answer before any model call", async () => {
    const call = fakeCall({ answerId: null, fact: "x", reply: "x" });
    expect(await answerInOwnWords(U.id, TZ, q.empty, "   ", "today", call)).toEqual({ status: "bad-answer" });
    expect(await answerInOwnWords(U.id, TZ, q.empty, "x".repeat(MAX_OWN_WORDS + 1), "today", call)).toEqual({
      status: "bad-answer",
    });
    expect(call.seen).toEqual([]);
    expect((await questionRow(q.empty)).status).toBe("open");
  });

  it("(7) a call that throws surfaces as an InterpretError and nothing is written", async () => {
    const call: InterpretCall = async () => {
      throw new Error("429 rate limited");
    };
    await expect(answerInOwnWords(U.id, TZ, q.throws, "close it", "today", call)).rejects.toBeInstanceOf(InterpretError);
    // The message is the user's line; what the call said rides in `detail`
    // for the log (lib/understanding/interpret.ts InterpretError).
    const thrown = await answerInOwnWords(U.id, TZ, q.throws, "close it", "today", call).catch((e) => e);
    expect(thrown).toBeInstanceOf(InterpretError);
    expect((thrown as InterpretError).message).toBe("Could not read that right now.");
    expect((thrown as InterpretError).detail).toContain("429 rate limited");
    expect(await questionRow(q.throws)).toEqual({ status: "open", resolution: null });
    expect((await memoryRows()).some((m) => m.fact === "close it")).toBe(false);
  });

  it("(8) output that is not an interpretation is an InterpretError too, after the call is billed", async () => {
    const call = fakeCall({ answer: "close-both" });
    const thrown = await answerInOwnWords(U.id, TZ, q.shape, "close it", "today", call).catch((e) => e);
    expect(thrown).toBeInstanceOf(InterpretError);
    expect((thrown as InterpretError).message).toBe("Could not read that right now.");
    expect((thrown as InterpretError).detail).toMatch(/wrong shape/);
    expect(await questionRow(q.shape)).toEqual({ status: "open", resolution: null });
    const billed = await db.select({ model: usage.model }).from(usage).where(eq(usage.userId, U.id));
    expect(billed.filter((b) => b.model === "fake-interpret").length).toBeGreaterThanOrEqual(2);
  });

  it("(9) an empty reply from the model becomes a plain 'Noted.'", async () => {
    // A fresh question for this: (2) and (3) resolved theirs.
    const [row] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        rank: 0,
        status: "open",
        projectId: ids.caltrans,
        kind: "done_yet",
        question: "Did the statement go out?",
        context: '"Do the US Bank statement" is due tomorrow.',
        identity: "own-blank-reply",
        evidence: [{ type: "task", id: ids.statement }],
        answers: [{ id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] }],
      })
      .returning({ id: clarifications.id });
    const call = fakeCall({ answerId: "  ", fact: "  ", reply: "   " });
    const result = await answerInOwnWords(U.id, TZ, row.id, "tomorrow morning", "today", call);
    expect(result).toMatchObject({ status: "resolved", reply: "Noted.", applied: [{ op: "remember_fact" }] });
    // Blank answerId and blank fact are null: the words are the memory.
    expect((await memoryRows()).some((m) => m.fact === "tomorrow morning")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// The voice tool
// --------------------------------------------------------------------------

describe("answer_question with own_words", () => {
  const ctx = { userId: U.id, timezone: TZ };

  it("routes to answerInOwnWords and hands the reply back for the model to relay", async () => {
    scripted.next = { answerId: null, fact: "The packet goes to Walter after the statement.", reply: "The packet to Walter comes after the statement." };
    const outcome = await executeTool(ctx, "answer_question", {
      question_id: q.tool,
      own_words: "after the statement the packet goes to Walter",
    });
    expect(outcome.result).toEqual({
      status: "resolved",
      applied: [{ op: "remember_fact" }],
      failed: [],
      superseded: [],
      reply: "The packet to Walter comes after the statement.",
    });
    expect(outcome.toast).toEqual({ icon: "check", text: "Answered" });
    expect(scripted.next).toBeNull();
    expect(await questionRow(q.tool)).toEqual({
      status: "resolved",
      resolution: "In your words: after the statement the packet goes to Walter",
    });
    const kept = (await memoryRows()).find((m) => m.fact === "The packet goes to Walter after the statement.");
    expect(kept?.tags).toEqual(["Caltrans", "answer"]);
  });

  it("with neither answer_id nor own_words it asks for one, and writes nothing", async () => {
    const { result } = await executeTool(ctx, "answer_question", { question_id: q.tool2 });
    expect((result as { error?: string }).error).toMatch(/answer_id .* own_words/);
    const blank = await executeTool(ctx, "answer_question", { question_id: q.tool2, own_words: "   " });
    expect((blank.result as { error?: string }).error).toMatch(/answer_id .* own_words/);
    expect((await questionRow(q.tool2)).status).toBe("open");
  });

  it("with no model to read the words it says so plainly, and writes nothing", async () => {
    // Nothing scripted: the real interpretAnswer runs and, under vitest, throws.
    const { result } = await executeTool(ctx, "answer_question", {
      question_id: q.tool2,
      own_words: "not until Marissa signs",
    });
    expect((result as { error?: string }).error).toContain("Could not read that right now");
    expect(await questionRow(q.tool2)).toEqual({ status: "open", resolution: null });
    expect((await memoryRows()).some((m) => m.fact === "not until Marissa signs")).toBe(false);
  });

  it("answer_id still wins, with own_words riding as the note when there is none", async () => {
    const { result } = await executeTool(ctx, "answer_question", {
      question_id: q.tool2,
      answer_id: "not-yet",
      own_words: "there is one more step",
    });
    expect(result).toMatchObject({ status: "resolved", applied: [{ op: "remember_fact" }] });
    expect((result as { reply?: string }).reply).toBeUndefined();
    expect(await questionRow(q.tool2)).toEqual({ status: "resolved", resolution: "Not yet: there is one more step" });
  });
});

// --------------------------------------------------------------------------
// The route
// --------------------------------------------------------------------------

describe("POST /api/questions/[id]/answer with text", () => {
  const post = async (id: string, body: unknown) => {
    const { POST } = await import("@/app/api/questions/[id]/answer/route");
    return POST(
      new Request(`http://test/api/questions/${id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) }
    );
  };

  it("answers 503 when the words cannot be read, and nothing is written", async () => {
    // Nothing scripted: no model under vitest, as with no key in production.
    const res = await post(q.route, { text: "not until Marissa signs", source: "today" });
    expect(res.status).toBe(503);
    // Under vitest no provider has failed, so the line is the plain one, not
    // the provider's ("Reading is paused: …", lib/understanding/provider-health.ts).
    expect(await res.json()).toEqual({ error: "Could not read that right now." });
    expect(await questionRow(q.route)).toEqual({ status: "asked", resolution: null });
    expect((await memoryRows()).some((m) => m.fact === "not until Marissa signs")).toBe(false);
    expect(scheduled.calls).toEqual([]);
  });

  it("refuses both or neither of answerId and text with 400", async () => {
    const both = await post(q.route, { answerId: "not-yet", text: "not yet" });
    expect(both.status).toBe(400);
    expect((await both.json()).error).toContain("exactly one");
    const neither = await post(q.route, { source: "today" });
    expect(neither.status).toBe(400);
    const blank = await post(q.route, { text: "" });
    expect(blank.status).toBe(400);
    const long = await post(q.route, { text: "x".repeat(MAX_OWN_WORDS + 1) });
    expect(long.status).toBe(400);
    expect((await questionRow(q.route)).status).toBe("asked");
  });

  it("carries the reply in the resolved body when the words are read", async () => {
    scripted.next = { answerId: "not-yet", fact: null, reply: "You are not there yet." };
    const res = await post(q.route, { text: "not yet, one more step", source: "today" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "resolved",
      projectId: ids.caltrans,
      applied: [{ op: "remember_fact" }],
      failed: [],
      superseded: [],
      reply: "You are not there yet.",
    });
    expect(await questionRow(q.route)).toEqual({ status: "resolved", resolution: "Not yet: not yet, one more step" });
    // The note on an answer that only resolves is kept as a memory, tagged
    // with the project and the source, as for a tapped pill with a note.
    const kept = (await memoryRows()).find((m) => m.fact.endsWith(": not yet, one more step"));
    expect(kept?.tags).toEqual(["Caltrans", "today"]);
    // SPEC §6 step 4: the project's re-run was scheduled, once, and only now.
    expect(scheduled.calls).toHaveLength(1);
    expect(typeof scheduled.calls[0]).toBe("function");
  });
});
