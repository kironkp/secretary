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
import { getQuestion } from "./questions";
import { upsertAsked } from "./record";
import { writeSchema, type Asked, type Write } from "./types";

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
    }
  | { status: "not-open" }
  | { status: "not-found" }
  | { status: "bad-answer" };

const isOpen = (status: string) => status === "open" || status === "asked";

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
      return viaTool(ctx, "update_task", {
        task: w.taskId,
        status: "blocked",
        blocked_reason: w.reason,
      });
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

  // The stored writes are read back through the schema (types.ts) rather
  // than trusted: a row seeded or migrated by hand with an op outside the
  // closed list is a bad answer, refused whole, not a crash halfway through.
  const parsed = z.array(writeSchema).safeParse(answer.writes);
  if (!parsed.success) return { status: "bad-answer" };
  const writes = parsed.data;

  // SPEC §5, §6: ids come from the evidence, or the answer is refused whole.
  const allowed = new Set(question.evidence.map((s) => `${s.type}:${s.id}`));
  for (const w of writes) {
    const target = targetOf(w);
    if (target && !allowed.has(`${target.type}:${target.id}`)) return { status: "bad-answer" };
  }

  const now = new Date();
  const ctx: ToolContext = { userId, timezone };
  // SPEC §6 step 3: resolve, with the note kept as the resolution.
  const trimmedNote = note?.trim() ?? "";
  const resolution = trimmedNote ? `${answer.label}: ${trimmedNote}` : answer.label;

  // SPEC §6 step 1, "refuse unless open", has to hold against two answers
  // landing at once — a tap and a spoken one. The row is locked for the
  // length of the answer, so the second waits, then finds it resolved. The
  // tools write on their own connections and none of them touches this row,
  // so the lock cannot wait on them.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, question.id)))
      .for("update");
    if (!locked) return { status: "not-found" };
    if (!isOpen(locked.status)) return { status: "not-open" };

    const applied: AppliedWrite[] = [];
    const failed: FailedWrite[] = [];
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
      } else {
        failed.push({ op: w.op, ...(id ? { id } : {}), error: outcome.error });
      }
    }

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
      const outcome = await viaTool(ctx, "remember_fact", { fact, tags });
      if (outcome.ok) applied.push({ op: "remember_fact" });
      else failed.push({ op: "remember_fact", error: outcome.error });
    }

    await tx
      .update(clarifications)
      .set({ status: "resolved", resolution })
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, question.id)));

    if (question.projectId) {
      await logAnswer(userId, question.projectId, question.id, answer.label, now);
    }

    return { status: "resolved", projectId: question.projectId, applied, failed };
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
  const entry: Asked = {
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
