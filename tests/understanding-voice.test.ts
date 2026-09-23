// docs/understanding/SPEC.md §6 (the voice answer) and §9 (the briefing
// reads the ranked queue), against the local database on one throwaway user
// seeded with the duplicate-CPO scenario and questions inserted by hand.
//
// What is asserted: the answer_question tool applies the stored writes
// through the same handlers a tap uses and resolves the question; its schema
// is flat enough for the Realtime API; the briefing carries the open
// questions with the ids the tool needs, in their own block; and the old
// CLARIFICATION QUEUE waits while one of those is open (one question a
// session), then carries the voice-flow kinds and nothing else.
// No model is involved: the re-run after an answer skips under vitest.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, tasks, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { nextClarification, openClarificationCount } from "@/lib/secretary/entities";
import {
  openAIVoiceToolDefs,
  toolSchemas,
  VOICE_TOOL_NAMES,
} from "@/lib/secretary/tool-schemas";
import { executeTool } from "@/lib/secretary/tools";
import { CPO_NOW, CPO_TZ, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = {
  id: `test-understanding-voice-${crypto.randomUUID()}`,
  email: `understanding-voice-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
const ctx = { userId: U.id, timezone: TZ };

let ids: CpoIds;
const q = { close: "", statement: "", asr: "" };

const questionRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, id)));
  return row;
};

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Voice Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);

  const base = { userId: U.id, status: "open" as const };
  const inserted = await db
    .insert(clarifications)
    .values([
      {
        ...base,
        kind: "doesnt_add_up",
        rank: 200,
        question: "CPO 2073 is on your list twice?",
        context: "One copy is finished; another is still open with 0 of 4 steps done.",
        projectId: ids.caltrans,
        identity: "voice-close",
        evidence: [
          { type: "task", id: ids.doneCpo },
          { type: "task", id: ids.blockedCpo },
        ],
        answers: [
          {
            id: "close-it",
            label: "Close it",
            writes: [{ op: "complete_task", taskId: ids.blockedCpo }, { op: "resolve" }],
          },
          { id: "keep-it", label: "Keep it", writes: [{ op: "resolve" }] },
        ],
      },
      {
        ...base,
        kind: "need_to_know",
        // Rank 0: the hero, so it is the FIRST line of the block.
        rank: 0,
        question: "Is the US Bank statement the last step before CPO 2073 is reconciled?",
        context: '"Do the US Bank statement" is due tomorrow.',
        projectId: ids.caltrans,
        identity: "voice-statement",
        evidence: [{ type: "task", id: ids.statement }],
        answers: [
          {
            id: "yes-last-step",
            label: "Yes, that is the last step",
            writes: [
              { op: "remember_fact", fact: "The statement is the last step.", tags: ["Caltrans"] },
              { op: "resolve" },
            ],
          },
          { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
        ],
      },
      // A voice-flow row: belongs to the CLARIFICATION QUEUE, never to OPEN
      // QUESTIONS. Its subject is used in no message, so the ASR retire
      // leaves it alone.
      {
        ...base,
        kind: "asr_span",
        subject: "Walter Myara",
        question: 'I heard "Walter Myara" — is that Walter Maiara, or someone new?',
        context: "send it to Walter Myara",
      },
    ])
    .returning({ id: clarifications.id });
  q.close = inserted[0].id;
  q.statement = inserted[1].id;
  q.asr = inserted[2].id;
});

afterAll(async () => {
  // The spoken answer schedules a re-run without waiting; give it a moment
  // to skip (no model under vitest) before the user it reads is deleted.
  await new Promise((r) => setTimeout(r, 300));
  await db.delete(user).where(eq(user.id, U.id));
});

describe("answer_question, the voice tool", () => {
  it("is on the voice tool list with a flat schema: no oneOf, anyOf, allOf or $ref", () => {
    expect(VOICE_TOOL_NAMES).toContain("answer_question");
    const def = openAIVoiceToolDefs().find((t) => t.name === "answer_question");
    expect(def).toBeTruthy();
    const json = JSON.stringify(def?.parameters);
    for (const banned of ["oneOf", "anyOf", "allOf", "$ref"]) expect(json).not.toContain(banned);
    const params = def?.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(params.properties ?? {}).sort()).toEqual(
      ["answer_id", "note", "own_words", "question_id"].sort()
    );
    // answer_id is optional since own_words: one flat tool, two ways to answer.
    expect(params.required).toEqual(["question_id"]);
    expect(def?.description).toContain("Never use resolve_clarification");
    // Bounded strings: the schema refuses an id longer than the column would hold.
    expect(toolSchemas.answer_question.safeParse({ question_id: "x".repeat(81), answer_id: "a" }).success).toBe(false);
  });

  it("an unknown question comes back as a plain error, not a throw", async () => {
    const { result } = await executeTool(ctx, "answer_question", {
      question_id: "no-such-question",
      answer_id: "close-it",
    });
    expect((result as { error?: string }).error).toContain("no-such-question");
  });

  it("an unknown answer id on a real question is refused with the ids to use", async () => {
    const { result } = await executeTool(ctx, "answer_question", {
      question_id: q.close,
      answer_id: "something-else",
    });
    expect((result as { error?: string }).error).toContain("something-else");
    expect((await questionRow(q.close)).status).toBe("open");
  });

  it("the Close it answer marks the task done through complete_task and resolves the question", async () => {
    const outcome = await executeTool(ctx, "answer_question", {
      question_id: q.close,
      answer_id: "close-it",
      note: "the new one is 0394",
    });
    const result = outcome.result as {
      status?: string;
      applied?: { op: string; id?: string }[];
      failed?: unknown[];
    };
    expect(result.status).toBe("resolved");
    expect(result.applied).toEqual([{ op: "complete_task", id: ids.blockedCpo }]);
    expect(result.failed).toEqual([]);
    expect(outcome.toast).toEqual({ icon: "check", text: "Answered" });

    const [task] = await db
      .select({ status: tasks.status, completedAt: tasks.completedAt })
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), eq(tasks.id, ids.blockedCpo)));
    expect(task.status).toBe("done");
    expect(task.completedAt).not.toBeNull();

    const row = await questionRow(q.close);
    expect(row.status).toBe("resolved");
    expect(row.resolution).toBe("Close it: the new one is 0394");
  });

  it("answering it again says it was already answered", async () => {
    const { result } = await executeTool(ctx, "answer_question", {
      question_id: q.close,
      answer_id: "keep-it",
    });
    expect((result as { error?: string }).error).toContain("already answered");
  });
});

describe("resolve_clarification, the voice-flow tool", () => {
  it("never closes a question of the three understanding kinds, however well the text matches", async () => {
    const [row] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        kind: "need_to_know",
        rank: 100,
        status: "open",
        projectId: ids.caltrans,
        identity: "voice-not-for-resolve",
        question: "Is the parking permit on the Caltrans list on purpose?",
        context: "why",
        evidence: [{ type: "task", id: ids.statement }],
        answers: [{ id: "yes", label: "Yes", writes: [{ op: "resolve" }] }],
      })
      .returning({ id: clarifications.id });
    const { result } = await executeTool(ctx, "resolve_clarification", {
      question: "parking permit on the Caltrans list",
      answer: "yes, on purpose",
      action: "note",
    });
    expect((result as { error?: string }).error).toContain("No open clarification");
    expect(await questionRow(row.id)).toMatchObject({ status: "open", resolution: null, resolvedAt: null });
    await db.delete(clarifications).where(and(eq(clarifications.userId, U.id), eq(clarifications.id, row.id)));
  });

  it("stamps resolved_at on the voice-flow row it resolves, like every other way out of pending", async () => {
    const [row] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        kind: "asr_span",
        status: "open",
        subject: "Marisa Toledo",
        question: 'I heard "Marisa Toledo" — is that Marissa, or someone new?',
        context: "send it to Marisa Toledo",
      })
      .returning({ id: clarifications.id });
    const { result } = await executeTool(ctx, "resolve_clarification", {
      question: "Marisa Toledo",
      answer: "someone new, leave it",
      action: "note",
    });
    expect((result as { resolved?: boolean }).resolved).toBe(true);
    const after = await questionRow(row.id);
    expect(after.status).toBe("resolved");
    expect(after.resolution).toBe("note: someone new, leave it");
    expect(after.resolvedAt).not.toBeNull();
    await db.delete(clarifications).where(and(eq(clarifications.userId, U.id), eq(clarifications.id, row.id)));
  });
});

describe("the briefing", () => {
  let text = "";

  it("carries OPEN QUESTIONS with the question_id and the answer ids, the hero first", async () => {
    ({ text } = await buildBriefing(U.id, TZ));
    expect(text).toContain("OPEN QUESTIONS");
    const block = text.split("OPEN QUESTIONS")[1].split("\n\n")[0];
    expect(block).toContain("answer_question");
    expect(block).toContain("Never resolve_clarification for these");
    const lines = block.split("\n").filter((l) => l.startsWith("- question_id: "));
    // The closed one is gone; the need_to_know row is the only open one.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`question_id: ${q.statement}`);
    expect(lines[0]).toContain("Need to know");
    expect(lines[0]).toContain("Is the US Bank statement the last step");
    expect(lines[0]).toContain('why: "Do the US Bank statement" is due tomorrow.');
    // Semicolons between answers: a label may itself carry a comma.
    expect(lines[0]).toContain("answers: yes-last-step=Yes, that is the last step; not-yet=Not yet");
    expect(block).not.toContain(q.close);
  });

  it("injecting a question marks it surfaced, the way Today does", async () => {
    const row = await questionRow(q.statement);
    expect(row.surfacedAt).not.toBeNull();
    // Still open: surfacing is asking, not answering (SPEC §5).
    expect(row.status).toBe("open");
  });

  it("while an understanding question is open the CLARIFICATION QUEUE waits: one question a session", async () => {
    // SPEC §6: the briefing "reads the new kinds first". The ASR row is not
    // injected alongside, and not marked asked either, because it was not asked.
    expect(text).not.toContain("CLARIFICATION QUEUE");
    expect(text).not.toContain("Walter Myara");
    expect((await questionRow(q.asr)).status).toBe("open");
  });

  it("with no understanding question open the CLARIFICATION QUEUE carries the asr_span row and none of the new kinds", async () => {
    // The Close it row was answered above; resolve the statement row the way
    // an answer would, and the next session reaches the voice-flow queue.
    await db
      .update(clarifications)
      .set({ status: "resolved", resolution: "Not yet" })
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, q.statement)));
    ({ text } = await buildBriefing(U.id, TZ));
    expect(text).not.toContain("OPEN QUESTIONS");
    expect(text).toContain("CLARIFICATION QUEUE");
    const block = text.split("CLARIFICATION QUEUE")[1].split("\n\n")[0];
    expect(block).toContain("Walter Myara");
    expect(block).not.toContain(q.statement);
    expect(block).not.toContain("US Bank statement");
    expect(block).not.toContain("question_id");
    // Surfacing marked it asked, so it is no longer counted as open.
    expect((await questionRow(q.asr)).status).toBe("asked");
  });

  it("nextClarification and openClarificationCount see only the four voice-flow kinds", async () => {
    // Put the asr row back to open and add an open need_to_know of rank 0:
    // the next clarification must still be the asr row, and the count 1.
    await db
      .update(clarifications)
      .set({ status: "open" })
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, q.asr)));
    const [fresh] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        kind: "need_to_know",
        rank: 0,
        question: "Which CPO is next?",
        context: "The rule is one a month.",
        projectId: ids.caltrans,
        identity: "voice-next-cpo",
        evidence: [{ type: "memory", id: ids.memMonthly }],
        answers: [{ id: "unknown", label: "Not decided", writes: [{ op: "resolve" }] }],
        status: "open",
      })
      .returning({ id: clarifications.id });

    expect(await openClarificationCount(U.id)).toBe(1);
    const next = await nextClarification(U.id);
    expect(next?.id).toBe(q.asr);
    expect(next?.kind).toBe("asr_span");
    expect((await questionRow(fresh.id)).status).toBe("open");
    expect(await openClarificationCount(U.id)).toBe(0);
  });
});
