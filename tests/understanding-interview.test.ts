// The Interview (app/(app)/interview, docs/understanding/SPEC.md §5, §6):
// the queue across projects in rank order, the answered-today count, the new
// set_project write from validation through to the task, a note kept as a
// memory when the answer itself writes nothing, and the interview addendum
// on the prompt. DB-backed on one throwaway user seeded with the
// duplicate-CPO scenario; no live model (renderBundle is pure and the run
// gets a fake).
//
// The reads come before the writes on purpose: buildInterview marks the
// front question surfaced and the answer path logs when an answer landed,
// so the queue and count assertions run first, on the seeds alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clarifications,
  memories,
  projects,
  records,
  tasks,
  understandingRuns,
  user,
} from "@/lib/db/schema";
import { appliedInWords, writesInWords } from "@/components/today/copy";
import { footerLine, progressLine, relativeTime } from "@/components/interview/words";
import { answerQuestion, type AnswerSource } from "@/lib/understanding/answer";
import { gatherProject } from "@/lib/understanding/gather";
import { renderBundle, toRunOutput } from "@/lib/understanding/prompt";
import { getQuestion } from "@/lib/understanding/questions";
import { runProject } from "@/lib/understanding/run";
import { buildInterview } from "@/lib/understanding/today";
import type { Bundle, ProjectRecord, RunOutput, Write } from "@/lib/understanding/types";
import { validateRunOutput } from "@/lib/understanding/validate";
import {
  CPO_NOW,
  CPO_TZ,
  fakeModel,
  minimalOutputFor,
  seedCpoScenario,
  type CpoIds,
} from "./fixtures/understanding";

const U = {
  id: `test-understanding-interview-${crypto.randomUUID()}`,
  email: `understanding-interview-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
const HOUR_MS = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR_MS);

let ids: CpoIds;
const q = {
  need: "",
  addUp: "",
  doneYet: "",
  resolvedToday: "",
  resolvedYesterday: "",
  asr: "",
  fileIt: "",
  fileNowhere: "",
  fileOutside: "",
  noteOnly: "",
  noteWithWrite: "",
};
const t = { nowhere: "", withWrite: "", fileIt: "" };

const answer = (id: string, answerId: string, note?: string, source?: AnswerSource) =>
  answerQuestion(U.id, TZ, id, answerId, note, source);

const taskRow = async (id: string) => {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.userId, U.id), eq(tasks.id, id)));
  return row;
};

const projectCount = async () => {
  const [{ n }] = await db.select({ n: count() }).from(projects).where(eq(projects.userId, U.id));
  return n;
};

const memoryCount = async () => {
  const [{ n }] = await db.select({ n: count() }).from(memories).where(eq(memories.userId, U.id));
  return n;
};

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

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Interview Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);

  // The set_project answer gets a task of its own: an answer that changes a
  // row sets aside every other pending question resting on it (answer.ts),
  // and the queue rows here rest on the seeded album task.
  const [nowhere, withWrite, fileIt] = await db
    .insert(tasks)
    .values([
      { userId: U.id, projectId: ids.album, title: "Order the test pressing", status: "todo" },
      { userId: U.id, projectId: ids.album, title: "Send the weekly mix to the band", status: "todo" },
      { userId: U.id, projectId: ids.album, title: "Chase the label about the artwork", status: "todo" },
    ])
    .returning({ id: tasks.id });
  t.nowhere = nowhere.id;
  t.withWrite = withWrite.id;
  t.fileIt = fileIt.id;

  const keep = [{ id: "keep", label: "Keep it", writes: [{ op: "resolve" }] as Write[] }];
  const one = (
    key: keyof typeof q,
    projectId: string,
    kind: "need_to_know" | "doesnt_add_up" | "done_yet",
    rank: number,
    evidence: { type: "task" | "memory"; id: string }[],
    answers: { id: string; label: string; writes: Write[] }[],
    status: "open" | "asked" | "resolved" = "open"
  ) => ({
    userId: U.id,
    kind,
    question: `Interview ${key}?`,
    context: "Seeded for the interview test.",
    projectId,
    identity: `interview-${key}`,
    evidence,
    answers,
    rank,
    status,
  });

  const inserted = await db
    .insert(clarifications)
    .values([
      // The queue proper, across two projects, ranks apart so the order is the point.
      one("need", ids.caltrans, "need_to_know", 100, [{ type: "task", id: ids.statement }], keep),
      one("addUp", ids.album, "doesnt_add_up", 200, [{ type: "task", id: ids.albumOverdue }], keep),
      one("doneYet", ids.caltrans, "done_yet", 300, [{ type: "task", id: ids.checkCpo }], keep, "asked"),
      // Answered: one today, one yesterday, on the user's calendar (below, on the record).
      one("resolvedToday", ids.caltrans, "need_to_know", 0, [{ type: "task", id: ids.statement }], keep, "resolved"),
      one("resolvedYesterday", ids.caltrans, "need_to_know", 0, [{ type: "task", id: ids.statement }], keep, "resolved"),
      // The set_project answers. Ranks past the queue proper.
      one("fileIt", ids.album, "need_to_know", 400, [{ type: "task", id: t.fileIt }], [
        {
          id: "file-it",
          label: "File it under Caltrans",
          // Lower case on purpose: the name is resolved the way a spoken one is.
          writes: [{ op: "set_project", taskId: t.fileIt, project: "caltrans" }, { op: "resolve" }],
        },
        ...keep,
      ]),
      one("fileNowhere", ids.album, "need_to_know", 410, [{ type: "task", id: t.nowhere }], [
        {
          id: "file-it",
          label: "File it under Nowhere Land",
          writes: [{ op: "set_project", taskId: t.nowhere, project: "Nowhere Land" }, { op: "resolve" }],
        },
        ...keep,
      ]),
      one("fileOutside", ids.caltrans, "need_to_know", 420, [{ type: "task", id: ids.statement }], [
        {
          id: "file-it",
          label: "File it under Album",
          // Names a task that is not in the evidence: refused whole.
          writes: [{ op: "set_project", taskId: ids.checkCpo, project: "Album" }, { op: "resolve" }],
        },
        ...keep,
      ]),
      // A note with nothing else to write becomes a memory; with a write it does not.
      one("noteOnly", ids.album, "doesnt_add_up", 430, [{ type: "task", id: ids.albumOverdue }], keep),
      one("noteWithWrite", ids.album, "done_yet", 440, [{ type: "task", id: t.withWrite }], [
        {
          id: "done",
          label: "Done",
          writes: [{ op: "complete_task", taskId: t.withWrite }, { op: "resolve" }],
        },
        ...keep,
      ]),
    ])
    .returning({ id: clarifications.id });
  [
    q.need,
    q.addUp,
    q.doneYet,
    q.resolvedToday,
    q.resolvedYesterday,
    q.fileIt,
    q.fileNowhere,
    q.fileOutside,
    q.noteOnly,
    q.noteWithWrite,
  ] = inserted.map((r) => r.id);

  // A voice-flow kind, open: never in the queue.
  const [asr] = await db
    .insert(clarifications)
    .values({
      userId: U.id,
      kind: "referent",
      subject: "CPS",
      question: "Did you mean CPO?",
      status: "open",
      rank: 0,
    })
    .returning({ id: clarifications.id });
  q.asr = asr.id;

  // The Caltrans record carries when the two answered questions were
  // answered: one an hour ago (today in Los Angeles), one 26 hours ago
  // (yesterday there). The Album has no record; its questions still answer.
  await db.insert(records).values({
    userId: U.id,
    projectId: ids.caltrans,
    body: {
      ...emptyRecord(),
      asked: [
        { questionId: q.resolvedToday, askedAt: at(-2).toISOString(), answer: "Keep it", answeredAt: at(-1).toISOString() },
        { questionId: q.resolvedYesterday, askedAt: at(-30).toISOString(), answer: "Keep it", answeredAt: at(-26).toISOString() },
      ],
    },
    inputsHash: "seed",
    words: { ledes: {} },
    updatedAt: at(-1),
  });

  await db.insert(understandingRuns).values([
    { userId: U.id, projectId: ids.caltrans, startedAt: at(-3), finishedAt: at(-3), status: "ok" },
    { userId: U.id, projectId: ids.album, startedAt: at(-1), finishedAt: at(-1), status: "ok" },
  ]);
});

afterAll(async () => {
  // records, clarifications, memories and understanding_runs cascade from the user.
  await db.delete(user).where(eq(user.id, U.id));
});

describe("the words", () => {
  it("counts progress through the sitting, not a position in the queue", () => {
    expect(progressLine(0, 8, "Caltrans")).toBe("Question 1 of 8 · Caltrans");
    expect(progressLine(3, 5, null)).toBe("Question 4 of 8");
    expect(progressLine(2, 0, "Caltrans")).toBe("Nothing waiting");
  });

  it("says when the projects were last read, coarsely and in digits", () => {
    const now = NOW;
    expect(relativeTime(null, now)).toBe("not yet");
    expect(relativeTime("not a date", now)).toBe("not yet");
    expect(relativeTime(at(0).toISOString(), now)).toBe("just now");
    expect(relativeTime(new Date(now.getTime() - 90_000).toISOString(), now)).toBe("1 minute ago");
    expect(relativeTime(at(-1).toISOString(), now)).toBe("1 hour ago");
    expect(relativeTime(at(-5).toISOString(), now)).toBe("5 hours ago");
    expect(relativeTime(at(-30).toISOString(), now)).toBe("yesterday");
    expect(relativeTime(at(-24 * 12).toISOString(), now)).toBe("12 days ago");
    expect(footerLine(2, at(-3).toISOString(), now)).toBe("2 answered today · last read 3 hours ago");
  });

  it("puts set_project into words, naming the project when it is one project", () => {
    expect(writesInWords([{ op: "set_project", project: "Caltrans" }, { op: "resolve" }])).toBe(
      "files it under Caltrans"
    );
    expect(
      writesInWords([
        { op: "set_project", project: "Caltrans" },
        { op: "set_project", project: "Caltrans" },
      ])
    ).toBe("files 2 tasks under Caltrans");
    expect(
      writesInWords([{ op: "set_project", project: "Caltrans" }, { op: "set_project", project: "Album" }])
    ).toBe("files 2 tasks");
    expect(appliedInWords([{ op: "set_project", project: "Caltrans" }])).toBe(
      "Filed it under Caltrans"
    );
    expect(
      appliedInWords([{ op: "complete_task" }, { op: "set_project", project: "Album" }])
    ).toBe("Closed 1 task and filed it under Album");
  });
});

describe("buildInterview", () => {
  it("(1) lists every open question across projects in rank order, with counts and the last read", async () => {
    const data = await buildInterview(U.id, TZ, NOW);

    expect(data.queue.map((row) => row.id)).toEqual([
      q.need,
      q.addUp,
      q.doneYet,
      q.fileIt,
      q.fileNowhere,
      q.fileOutside,
      q.noteOnly,
      q.noteWithWrite,
    ]);
    expect(data.total).toBe(8);
    expect(data.queue.map((row) => row.id)).not.toContain(q.asr);
    expect(data.queue.map((row) => row.id)).not.toContain(q.resolvedToday);

    // Each question comes with what the screen needs: its project by name,
    // its kind's label, and its evidence resolved.
    expect(data.queue[0].projectName).toBe("Caltrans");
    expect(data.queue[0].kindLabel).toBe("Need to know");
    expect(data.queue[0].evidenceView).toEqual([
      { type: "task", id: ids.statement, label: "Still open", text: "Do the US Bank statement", meta: "due Sep 23" },
    ]);
    expect(data.queue[1].projectName).toBe("Album");
    expect(data.queue[1].kindLabel).toBe("Doesn't add up");
    expect(data.queue[2].status).toBe("asked");

    // Only today's answer, on the user's calendar, is counted.
    expect(data.answeredToday).toBe(1);
    // The later of the two runs.
    expect(data.lastRunAt).toBe(at(-1).toISOString());
  });

  it("(2) marks only the question at the front as surfaced", async () => {
    const data = await buildInterview(U.id, TZ, NOW);
    expect(data.queue[0].surfacedAt).toEqual(NOW);
    expect(data.queue[1].surfacedAt).toBeNull();
    expect((await getQuestion(U.id, q.need))?.surfacedAt).toEqual(NOW);
    expect((await getQuestion(U.id, q.addUp))?.surfacedAt).toBeNull();
  });
});

describe("set_project", () => {
  let bundle: Bundle;

  beforeAll(async () => {
    const b = await gatherProject(U.id, ids.caltrans, { now: NOW, timezone: TZ });
    if (!b) throw new Error("no Caltrans bundle");
    bundle = b;
  });

  const withQuestion = (writes: unknown[]): unknown => {
    const base: RunOutput = minimalOutputFor(bundle);
    const title = bundle.tasksOpen.find((task) => task.id === ids.checkCpo)?.title ?? "";
    return {
      ...base,
      questions: [
        {
          kind: "need_to_know",
          question: "Does the check on CPO 2073 belong under Caltrans?",
          why: `"${title}" sits in no project.`,
          evidence: [{ type: "task", id: ids.checkCpo }],
          answers: [
            { id: "file-it", label: "File it under Caltrans", writes },
            { id: "leave", label: "Leave it", writes: [{ op: "resolve" }] },
          ],
        },
      ],
    };
  };

  it("(3) is accepted by validateRunOutput on a task in the bundle, and refused on one outside it", () => {
    const ok = validateRunOutput(
      withQuestion([{ op: "set_project", taskId: ids.checkCpo, project: "Caltrans" }, { op: "resolve" }]),
      bundle
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.questions[0].answers[0].writes[0]).toEqual({
        op: "set_project",
        taskId: ids.checkCpo,
        project: "Caltrans",
      });
    }

    const ghost = validateRunOutput(
      withQuestion([{ op: "set_project", taskId: "ghost", project: "Caltrans" }, { op: "resolve" }]),
      bundle
    );
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.errors.join("\n")).toMatch(/unknown task id "ghost"/);

    const blank = validateRunOutput(
      withQuestion([{ op: "set_project", taskId: ids.checkCpo, project: "  " }, { op: "resolve" }]),
      bundle
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.join("\n")).toMatch(/project/);

    // The bundle carries the user's project names (both seeded projects), and
    // a name that lands on none of them is refused here rather than failing
    // at apply time; the matching is resolveProject's, so "album" lands.
    expect(bundle.projectNames).toEqual(["Album", "Caltrans"]);
    const lower = validateRunOutput(
      withQuestion([{ op: "set_project", taskId: ids.checkCpo, project: "album" }, { op: "resolve" }]),
      bundle
    );
    expect(lower.ok).toBe(true);
    const nowhere = validateRunOutput(
      withQuestion([{ op: "set_project", taskId: ids.checkCpo, project: "Nowhere Land" }, { op: "resolve" }]),
      bundle
    );
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.errors.join("\n")).toMatch(/no project named "Nowhere Land".*Album, Caltrans/);

    // The model writes one flat object; fields the op does not use are dropped.
    const mapped = toRunOutput({
      record: {},
      questions: [
        { answers: [{ writes: [{ op: "set_project", taskId: "t", project: "Caltrans", reason: "stray" }] }] },
      ],
      words: { ledes: [] },
    }) as { questions: { answers: { writes: unknown[] }[] }[] };
    expect(mapped.questions[0].answers[0].writes[0]).toEqual({ op: "set_project", taskId: "t", project: "Caltrans" });
  });

  it("(4) is applied by answerQuestion: the task lands in the named project, resolved the way a spoken name is", async () => {
    expect((await taskRow(t.fileIt)).projectId).toBe(ids.album);
    const result = await answer(q.fileIt, "file-it");
    expect(result).toEqual({
      status: "resolved",
      projectId: ids.album,
      applied: [{ op: "set_project", id: t.fileIt, project: "Caltrans" }],
      failed: [],
      superseded: [],
    });
    expect((await taskRow(t.fileIt)).projectId).toBe(ids.caltrans);
  });

  it("(5) a name that is no project of the user's fails the write and mints nothing", async () => {
    const before = await projectCount();
    const result = await answer(q.fileNowhere, "file-it");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ op: "set_project", id: t.nowhere });
    expect(result.failed[0].error).toMatch(/no project named "Nowhere Land"/i);
    expect((await taskRow(t.nowhere)).projectId).toBe(ids.album);
    expect(await projectCount()).toBe(before);
  });

  it("(6) is refused whole for a task outside the evidence", async () => {
    expect(await answer(q.fileOutside, "file-it")).toEqual({ status: "bad-answer" });
    expect((await taskRow(ids.checkCpo)).projectId).toBe(ids.caltrans);
    expect((await getQuestion(U.id, q.fileOutside))?.status).toBe("open");
  });
});

describe("a note on an answer", () => {
  it("(7) with nothing else to write is kept as a memory tagged with the project and where it was answered", async () => {
    const before = await memoryCount();
    const result = await answer(q.noteOnly, "keep", "They are two different jobs; the second is the remix.", "interview");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.applied).toEqual([{ op: "remember_fact" }]);
    expect(result.failed).toEqual([]);
    expect(await memoryCount()).toBe(before + 1);

    const rows = await db
      .select({ fact: memories.fact, tags: memories.tags })
      .from(memories)
      .where(eq(memories.userId, U.id));
    const kept = rows.find((m) => m.fact.includes("the second is the remix"));
    expect(kept).toBeDefined();
    expect(kept?.tags).toEqual(["Album", "interview"]);
    // The question and the label go in front, so the note names what it is about.
    expect(kept?.fact).toBe(
      'Asked "Interview noteOnly?", you answered "Keep it": They are two different jobs; the second is the remix.'
    );
  });

  it("(8) alongside a real write is the resolution only, not a memory", async () => {
    const before = await memoryCount();
    const result = await answer(q.noteWithWrite, "done", "Sent it Friday.");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.applied).toEqual([{ op: "complete_task", id: t.withWrite }]);
    expect(await memoryCount()).toBe(before);
    const [row] = await db
      .select({ resolution: clarifications.resolution })
      .from(clarifications)
      .where(eq(clarifications.id, q.noteWithWrite));
    expect(row.resolution).toBe("Done: Sent it Friday.");
  });
});

describe("the interview mode", () => {
  const ADDENDUM_START = "The user is sitting down right now to organize their data with you, one question at a time.";

  it("(9) renderBundle appends the addendum after the closing line in interview mode and not otherwise", async () => {
    const bundle = await gatherProject(U.id, ids.caltrans, { now: NOW, timezone: TZ });
    if (!bundle) throw new Error("no Caltrans bundle");
    const plain = renderBundle(bundle);
    const closing = "Write the record, the questions and the words for this project now.";
    expect(plain).toContain(closing);
    expect(plain).not.toContain(ADDENDUM_START);
    expect(plain.trimEnd().endsWith(closing)).toBe(true);

    const interview = renderBundle(bundle, { mode: "interview" });
    expect(interview.indexOf(ADDENDUM_START)).toBeGreaterThan(interview.indexOf(closing));
    expect(interview).toContain("Up to 12 questions for this project, the most useful first.");
    expect(interview).toContain("tasks with no project; two tasks that look like the same job;");
    // Everything before the addendum is the ordinary message: the mode adds, it never rewrites.
    expect(interview.startsWith(plain)).toBe(true);
    expect(renderBundle(bundle, { mode: "sweep" })).toBe(plain);
  });

  it("(10) runProject hands the model the addendum in interview mode, and nothing else about the run changes", async () => {
    const fake = fakeModel((bundle) => minimalOutputFor(bundle));
    const result = await runProject(U.id, ids.caltrans, {
      timezone: TZ,
      now: NOW,
      model: fake,
      mode: "interview",
      dryRun: true,
    });
    expect(result.status).toBe("dry");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].user).toContain(ADDENDUM_START);
    // The system prompt is the cached one, unchanged by the mode.
    expect(fake.calls[0].system).not.toContain(ADDENDUM_START);

    const plain = fakeModel((bundle) => minimalOutputFor(bundle));
    await runProject(U.id, ids.caltrans, { timezone: TZ, now: NOW, model: plain, dryRun: true });
    expect(plain.calls[0].user).not.toContain(ADDENDUM_START);
  });
});
