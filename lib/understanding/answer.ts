// Answering a question — docs/understanding/SPEC.md §6.
//
// The writes an answer carries go through the EXISTING tool handlers, never
// straight to the tables: complete_task clears the task's follow-ups and
// spawns the next occurrence of a recurring task, update_task logs the
// check-in, and both are scoped to the user in SQL. The honesty rule (SPEC
// §10) is kept by the shape of the result: `applied` lists only the writes
// whose handler returned success, and the client says "Closed" for those and
// nothing else.
//
// The refusal in SPEC §5 — "an answer whose writes name an id not in
// `evidence` is refused by the API" — happens here, before any write, so a
// bad answer changes nothing at all.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { clarifications, expectations, records } from "@/lib/db/schema";
import { executeTool, resolveProject, type ToolContext } from "@/lib/secretary/tools";
import { tzOffsetMs } from "@/lib/time";
import { localDateInTz } from "./gather";
import { interpretAnswer, type InterpretCall } from "./interpret";
import { getQuestion, type QuestionRow } from "./questions";
import { upsertAsked } from "./record";
import { changedRowsOf, supersedeByWrites } from "./supersede";
import { viewQuestion } from "./today";
import { writeSchema, type Answer, type Asked, type Write } from "./types";

/**
 * Where an answer was given. A note kept as a memory is tagged with it, so
 * the next run can tell a line typed in the Interview from one on Today or
 * spoken on a call; the answer itself is the same whatever the source.
 */
export const ANSWER_SOURCES = ["today", "interview", "voice"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

/** `project` is the name a set_project landed on, as the project is really called, for the receipt. */
export type AppliedWrite = { op: string; id?: string; project?: string };
export type FailedWrite = { op: string; id?: string; error: string };

export type AnswerResult =
  | {
      status: "resolved";
      /** The question's project, for the run the route schedules after answering (SPEC §6 step 4). */
      projectId: string | null;
      applied: AppliedWrite[];
      failed: FailedWrite[];
      /**
       * The other pending questions this answer set aside: every one that
       * rested on a row the applied writes changed (supersede.ts). Empty
       * when nothing rested on them, or when no write changed a row; the
       * receipt names them only when there are any.
       */
      superseded: string[];
      /**
       * One sentence back to the user, only when the answer came in their
       * own words (answerInOwnWords): what Secretary read the words as. A
       * tapped answer has no reply; its receipt is appliedInWords.
       */
      reply?: string;
    }
  | { status: "not-open" }
  | { status: "not-found" }
  | { status: "bad-answer" };

type Resolved = Extract<AnswerResult, { status: "resolved" }>;

const isOpen = (status: string) => status === "open" || status === "asked";

/** The route and the voice tool cap the text here too; a longer one is a note, not an answer. */
export const MAX_OWN_WORDS = 1000;

/** The row a write touches, so it can be checked against the evidence. */
function targetOf(w: Write): { type: "task" | "expectation"; id: string } | null {
  switch (w.op) {
    case "complete_task":
    case "drop_task":
    case "set_due":
    case "set_recurrence":
    case "set_blocked_reason":
    case "set_project":
      return { type: "task", id: w.taskId };
    case "clear_expectation":
      return { type: "expectation", id: w.expectationId };
    case "remember_fact":
    case "resolve":
      return null;
  }
}

// --------------------------------------------------------------------------
// Dates: a set_due is written on the user's clock (SPEC §3)
// --------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The instant at which `tz`'s wall clock reads the fields packed into `wall` (a Date.UTC of them). */
function wallClockInTz(tz: string, wall: number): Date {
  // Two passes: the offset in force at the guess, then at the answer, so a
  // DST change between the two cannot leave the result an hour off.
  const guess = new Date(wall - tzOffsetMs(tz, new Date(wall)));
  return new Date(wall - tzOffsetMs(tz, guess));
}

/**
 * The instant a set_due means. The model writes dueAt as YYYY-MM-DD "in the
 * user's timezone" (prompt.ts), and SPEC §3 resolves dates against the
 * user's clock; update_task's own parser would read the bare date as UTC
 * midnight, which in Los Angeles is the evening BEFORE. A date-only value
 * becomes the start of that local day: the earliest instant the tasks
 * binding counts as due that day, and the one on which "today" and "3d
 * overdue" are whole days. A datetime with no offset is the user's wall
 * clock too, never the server's. Null when the string is not a date at all.
 */
export function dueInstantInTz(tz: string, dueAt: string): Date | null {
  if (DATE_ONLY.test(dueAt)) {
    const [y, m, d] = dueAt.split("-").map(Number);
    const wall = Date.UTC(y, m - 1, d);
    const start = wallClockInTz(tz, wall);
    if (localDateInTz(tz, start) === dueAt) return start;
    // A zone whose DST change falls on midnight has no 00:00 that day; the
    // first pass lands on the first minute that does exist.
    const first = new Date(wall - tzOffsetMs(tz, new Date(wall)));
    return localDateInTz(tz, first) === dueAt ? first : null;
  }
  if (HAS_OFFSET.test(dueAt)) {
    const at = new Date(dueAt);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const wall = new Date(`${dueAt}Z`);
  return Number.isNaN(wall.getTime()) ? null : wallClockInTz(tz, wall.getTime());
}

// --------------------------------------------------------------------------
// One write, through the tool that already knows how to do it (SPEC §6 step 2)
// --------------------------------------------------------------------------

type WriteOutcome = { ok: true; project?: string } | { ok: false; error: string };

/**
 * A tool result carrying { error } is a failed write; anything else
 * succeeded. A handler that throws (an argument its schema refuses, a date
 * it cannot parse) is a failed write too, not a failed request: the other
 * writes still run and the answer still resolves, with the failure reported.
 */
async function viaTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<WriteOutcome> {
  try {
    const outcome = await executeTool(ctx, name, args);
    const result = outcome.result;
    if (result && typeof result === "object" && "error" in result) {
      const error = (result as { error?: unknown }).error;
      if (error) return { ok: false, error: typeof error === "string" ? error : String(error) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function applyWrite(ctx: ToolContext, w: Write, now: Date): Promise<WriteOutcome> {
  switch (w.op) {
    case "complete_task":
      return viaTool(ctx, "complete_task", { task: w.taskId });
    case "drop_task":
      return viaTool(ctx, "update_task", { task: w.taskId, status: "dropped" });
    case "set_due": {
      const at = dueInstantInTz(ctx.timezone, w.dueAt);
      if (!at) return { ok: false, error: `Not a date: ${w.dueAt}` };
      return viaTool(ctx, "update_task", { task: w.taskId, due_at: at.toISOString() });
    }
    case "set_recurrence":
      return viaTool(ctx, "update_task", { task: w.taskId, recurrence: w.recurrence });
    case "set_blocked_reason":
      // An empty reason is the unblock: back to todo, and the tool clears
      // the blocker for any status that is not "blocked".
      return w.reason.trim()
        ? viaTool(ctx, "update_task", {
            task: w.taskId,
            status: "blocked",
            blocked_reason: w.reason,
          })
        : viaTool(ctx, "update_task", { task: w.taskId, status: "todo", blocked_reason: "" });
    case "set_project": {
      // update_task resolves a project name the way a spoken "file it under
      // Caltrans" is resolved, and when nothing matches it CREATES one
      // (resolveProject's default). A typo in a stored answer must not mint a
      // project, so the name is resolved here first with creation off, the
      // write fails when nothing matches, and the tool is handed the exact
      // name that did match so its own fuzzy pass cannot land elsewhere.
      const res = await resolveProject(ctx.userId, w.project, { create: false });
      if (!res.project) return { ok: false, error: `No project named "${w.project}"` };
      const outcome = await viaTool(ctx, "update_task", { task: w.taskId, project: res.project.name });
      return outcome.ok ? { ok: true, project: res.project.name } : outcome;
    }
    case "remember_fact":
      return viaTool(ctx, "remember_fact", { fact: w.fact, tags: w.tags });
    case "clear_expectation": {
      // No tool clears one expectation by id (clearExpectationsFor works per
      // task), so this is the one direct write, scoped by user like the rest.
      const cleared = await db
        .update(expectations)
        .set({ status: "cleared", clearedAt: now })
        .where(and(eq(expectations.userId, ctx.userId), eq(expectations.id, w.expectationId)))
        .returning({ id: expectations.id });
      return cleared.length ? { ok: true } : { ok: false, error: "No such follow-up" };
    }
    case "resolve":
      // The question closing itself: always done at the end, never here.
      return { ok: true };
  }
}

// --------------------------------------------------------------------------
// The pieces a tapped answer and a typed one share
// --------------------------------------------------------------------------

/**
 * The stored writes, read back through the schema (types.ts) rather than
 * trusted, and checked against the evidence: a row seeded or migrated by
 * hand with an op outside the closed list is refused whole, not a crash
 * halfway through, and (SPEC §5, §6) a write naming a task or expectation
 * outside the question's evidence refuses the answer before anything runs.
 * Null means bad-answer.
 */
function checkedWrites(question: QuestionRow, answer: Answer): Write[] | null {
  const parsed = z.array(writeSchema).safeParse(answer.writes);
  if (!parsed.success) return null;
  const allowed = new Set(question.evidence.map((s) => `${s.type}:${s.id}`));
  for (const w of parsed.data) {
    const target = targetOf(w);
    if (target && !allowed.has(`${target.type}:${target.id}`)) return null;
  }
  return parsed.data;
}

type Applied = { applied: AppliedWrite[]; failed: FailedWrite[] };

/**
 * The writes in order; a failed one is reported and the rest still run.
 * `succeeded` is the writes themselves that went through, for what they
 * changed (supersedeByWrites): a failed write changed nothing.
 */
async function applyWrites(
  ctx: ToolContext,
  writes: Write[],
  now: Date
): Promise<Applied & { succeeded: Write[] }> {
  const applied: AppliedWrite[] = [];
  const failed: FailedWrite[] = [];
  const succeeded: Write[] = [];
  for (const w of writes) {
    if (w.op === "resolve") continue;
    const id = targetOf(w)?.id;
    const outcome = await applyWrite(ctx, w, now);
    if (outcome.ok) {
      applied.push({
        op: w.op,
        ...(id ? { id } : {}),
        ...(outcome.project ? { project: outcome.project } : {}),
      });
      succeeded.push(w);
    } else {
      failed.push({ op: w.op, ...(id ? { id } : {}), error: outcome.error });
    }
  }
  return { applied, failed, succeeded };
}

/** A memory through remember_fact, reported the way any other write is. */
async function remember(ctx: ToolContext, fact: string, tags: string[], into: Applied): Promise<void> {
  const outcome = await viaTool(ctx, "remember_fact", { fact, tags });
  if (outcome.ok) into.applied.push({ op: "remember_fact" });
  else into.failed.push({ op: "remember_fact", error: outcome.error });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * SPEC §6 step 1, "refuse unless open", has to hold against two answers
 * landing at once — a tap and a spoken one, or a tap and the same words
 * typed on the Interview. The row is locked for the length of the answer, so
 * the second waits, then finds it resolved. The tools write on their own
 * connections and none of them touches this row, so the lock cannot wait on
 * them. `body` runs only for an open row.
 */
function withOpenRow(
  userId: string,
  questionId: string,
  body: (tx: Tx) => Promise<Resolved>
): Promise<AnswerResult> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, questionId)))
      .for("update");
    if (!locked) return { status: "not-found" };
    if (!isOpen(locked.status)) return { status: "not-open" };
    return body(tx);
  });
}

/**
 * SPEC §6 step 3: the question closes, with what the user said as the
 * resolution and `closedAt` as the moment it stopped being pending.
 */
async function resolveRow(
  tx: Tx,
  userId: string,
  questionId: string,
  resolution: string,
  closedAt: Date
): Promise<void> {
  await tx
    .update(clarifications)
    .set({ status: "resolved", resolution, resolvedAt: closedAt })
    .where(and(eq(clarifications.userId, userId), eq(clarifications.id, questionId)));
}

/**
 * One listed answer, applied: its writes in order, the note kept, the row
 * resolved, the record's asked entry updated. Both a tap (answerQuestion)
 * and typed words the model read as this answer (answerInOwnWords) end
 * here, so there is one write loop and one meaning of "answered". `read`
 * is present only for typed words: what the model distilled from them.
 */
async function commitAnswer(
  tx: Tx,
  ctx: ToolContext,
  question: QuestionRow,
  answer: Answer,
  writes: Write[],
  note: string | undefined,
  source: AnswerSource | undefined,
  now: Date,
  read?: { fact: string | null }
): Promise<Resolved> {
  const trimmedNote = note?.trim() ?? "";
  const resolution = trimmedNote ? `${answer.label}: ${trimmedNote}` : answer.label;

  const { succeeded, ...outcome } = await applyWrites(ctx, writes, now);

  // A note on an answer that writes nothing ("Keep them", with a line
  // saying why) would otherwise live only in the resolution column, which
  // no run reads. It is kept as a memory tagged with the project's name,
  // which is how gather.ts finds a memory for a project, so the next run
  // reasons from what the user typed. The question and the label go in
  // front of the note: a memory reading "they are different jobs" on its
  // own names nothing. The second tag is where the answer was given
  // (Today, the Interview, a call), when the caller said; every surface
  // that takes a note comes through here.
  if (trimmedNote && writes.every((w) => w.op === "resolve")) {
    const tags = [question.projectName, source].filter((t): t is string => !!t);
    const fact = `Asked "${question.question}", you answered "${answer.label}": ${trimmedNote}`;
    await remember(ctx, fact, tags, outcome);
  } else if (read?.fact) {
    // Typed words that meant an answer AND said more ("yes, close them
    // both, the new one is 0394"): the writes carry the answer, and the
    // fact the model distilled from the rest is kept the way the fact path
    // below keeps one, under the project and "answer", so the explanation
    // the user typed reaches the next run. The words themselves reach it
    // through the asked entry, which logs the whole resolution.
    const tags = [question.projectName, "answer"].filter((t): t is string => !!t);
    await remember(ctx, read.fact, tags, outcome);
  }

  // The moment the question stops being pending is read AFTER the writes,
  // never before them: the settled guard (questions.ts, supersede.ts) takes
  // a row whose updated_at is later than this moment as new evidence, and
  // the rows this answer itself just changed carry stamps from a moment
  // ago. The same moment closes the questions the answer sets aside.
  const closedAt = new Date();
  // The rows the answer changed make every other pending question that
  // rests on one of them a question about a premise the user just changed
  // (SPEC §6): set aside here, in the same transaction, before the re-read
  // has had a chance to run and before the user can answer it. Only the
  // writes that went through count; a failed write changed nothing.
  const superseded = await supersedeByWrites(
    tx,
    ctx.userId,
    question.id,
    changedRowsOf(succeeded),
    closedAt
  );
  await resolveRow(tx, ctx.userId, question.id, resolution, closedAt);
  if (question.projectId) {
    // The resolution, not the bare label: SPEC §5 has asked[] carry the
    // answer text so the next run can reason from it, and with a note or
    // typed words that text is "Label: what they said".
    await logAnswer(ctx.userId, question.projectId, question.id, resolution, closedAt);
  }
  return { status: "resolved", projectId: question.projectId, ...outcome, superseded };
}

// --------------------------------------------------------------------------
// A tapped answer
// --------------------------------------------------------------------------

/**
 * Apply one answer to one question. Refuses (bad-answer) before touching
 * anything when the answer is unknown, its stored writes do not fit the
 * closed list, or any write names a task or expectation outside the
 * question's evidence. Otherwise applies the writes in order — a failed one
 * is reported and the rest still run — then resolves the question and logs
 * the answer on the project's record. The project's re-run is the caller's
 * to schedule (rerunAfterAnswer), so the response never waits on a model.
 */
export async function answerQuestion(
  userId: string,
  timezone: string,
  questionId: string,
  answerId: string,
  note?: string,
  source?: AnswerSource
): Promise<AnswerResult> {
  const question = await getQuestion(userId, questionId);
  if (!question) return { status: "not-found" };
  if (!isOpen(question.status)) return { status: "not-open" };

  const answer = question.answers.find((a) => a.id === answerId);
  if (!answer) return { status: "bad-answer" };
  const writes = checkedWrites(question, answer);
  if (!writes) return { status: "bad-answer" };

  const now = new Date();
  const ctx: ToolContext = { userId, timezone };
  return withOpenRow(userId, question.id, (tx) =>
    commitAnswer(tx, ctx, question, answer, writes, note, source, now)
  );
}

// --------------------------------------------------------------------------
// An answer in the user's own words
// --------------------------------------------------------------------------

/**
 * "Write your own": the user typed `text` instead of tapping an answer. One
 * model call (interpret.ts) reads it against the question. When the words
 * mean a listed answer, that answer is applied exactly as a tap would be,
 * with the words as its note, and a fact the model distilled from them on
 * top is kept as a memory (commitAnswer). When they add information
 * instead, the words (or the one-sentence fact the model distilled from
 * them) become a memory tagged with the project and "answer", the question
 * resolves as "In your words: …", and the record's asked entry carries the
 * words so the next run reasons from them. Either way the result carries
 * the model's one-sentence reply for the receipt.
 *
 * The model reads BEFORE the row is locked: a call takes seconds, and a
 * lock held that long would make a tap on the same question wait on a
 * model. An InterpretError (no model, a model error, unreadable output)
 * propagates with nothing written; the route answers 503 and the field
 * keeps the text. The re-run is the caller's to schedule, as for a tap.
 */
export async function answerInOwnWords(
  userId: string,
  timezone: string,
  questionId: string,
  text: string,
  source?: AnswerSource,
  call?: InterpretCall
): Promise<AnswerResult> {
  const question = await getQuestion(userId, questionId);
  if (!question) return { status: "not-found" };
  if (!isOpen(question.status)) return { status: "not-open" };

  const words = text.trim();
  if (!words || words.length > MAX_OWN_WORDS) return { status: "bad-answer" };

  const view = await viewQuestion(userId, question, timezone);
  const reading = await interpretAnswer(userId, timezone, view, words, call);

  const now = new Date();
  const ctx: ToolContext = { userId, timezone };

  if (reading.answerId) {
    const answer = question.answers.find((a) => a.id === reading.answerId);
    const writes = answer ? checkedWrites(question, answer) : null;
    // interpretAnswer only returns an id from this question's answers, so
    // this is a stored answer whose writes are malformed: refused, like a tap.
    if (!answer || !writes) return { status: "bad-answer" };
    return withOpenRow(userId, question.id, async (tx) => ({
      ...(await commitAnswer(tx, ctx, question, answer, writes, words, source, now, reading)),
      reply: reading.reply,
    }));
  }

  return withOpenRow(userId, question.id, async (tx) => {
    const outcome: Applied = { applied: [], failed: [] };
    // "answer" rather than the source: the tag says what kind of memory
    // this is (the user answering a question in their own words), and the
    // project's name is how gather.ts finds it for the next run.
    const tags = [question.projectName, "answer"].filter((t): t is string => !!t);
    await remember(ctx, reading.fact ?? words, tags, outcome);
    // A memory changes no row, so nothing else rests on what this answer did.
    const closedAt = new Date();
    await resolveRow(tx, userId, question.id, `In your words: ${words}`, closedAt);
    if (question.projectId) await logAnswer(userId, question.projectId, question.id, words, closedAt);
    return {
      status: "resolved",
      projectId: question.projectId,
      ...outcome,
      superseded: [],
      reply: reading.reply,
    };
  });
}

/**
 * The record's asked entry for this question gets the answer and when
 * (SPEC §5: "asked[] on the record carries the answer text so the next run
 * can reason from it"). The askedAt of the existing entry is kept; a
 * question answered before Today ever showed it (voice, later) is logged as
 * asked and answered now.
 */
async function logAnswer(
  userId: string,
  projectId: string,
  questionId: string,
  answer: string,
  now: Date
): Promise<void> {
  const [record] = await db
    .select({ body: records.body })
    .from(records)
    .where(and(eq(records.userId, userId), eq(records.projectId, projectId)))
    .limit(1);
  if (!record) return;
  const existing = record.body.asked?.find((a) => a.questionId === questionId);
  // Spread first: whatever surfacing wrote on the entry (the question's text
  // and evidence keys, when it did) survives the answer landing on it.
  const entry: Asked = {
    ...existing,
    questionId,
    askedAt: existing?.askedAt ?? now.toISOString(),
    answer,
    answeredAt: now.toISOString(),
  };
  await upsertAsked(userId, projectId, [entry]);
}

/**
 * SPEC §6 step 4 / §8: an answered project runs at once so the next screen
 * reflects the answer. Routes call this inside after() so the response never
 * waits; runProject swallows its own errors, and the import is lazy so the
 * answer path does not load the model clients until a run is actually due.
 * Under vitest there is no model and the run skips.
 */
export async function rerunAfterAnswer(
  userId: string,
  projectId: string,
  timezone: string
): Promise<void> {
  try {
    const { runProject } = await import("./run");
    await runProject(userId, projectId, { timezone });
  } catch (e) {
    console.error(
      `understanding: re-run after answer failed for project ${projectId}:`,
      e instanceof Error ? e.message : e
    );
  }
}
