// Today's data — docs/understanding/SPEC.md §7 (the Today line) and §9 (the
// surface): the line under the title, the hero question, the question rows,
// then past due and coming up. It renders the last record and the stored
// questions; it never waits for a run (SPEC §8, "never on read").
//
// Two rules from the spec are enforced here rather than in the page:
//   - A suggested task (source = suggested) never makes the past-due number
//     bigger (SPEC §10). It is counted separately and labelled as the app's own.
//   - Showing a question is what "asked" means (SPEC §5): the first time a row
//     is returned its surfacedAt is set and the project's record logs it, so
//     the next run can reason from what the user has already been asked.
import { and, count, eq, gte, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clarifications,
  documents,
  events,
  expectations,
  memories,
  messages,
  records,
  tasks,
  understandingRuns,
} from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import { resolveBinding } from "@/lib/workspace/bindings";
import type { BoundRow } from "@/lib/workspace/types";
import { listQuestions, type QuestionRow } from "./questions";
import { upsertAsked } from "./record";
import { QUESTION_KINDS, type Asked, type QuestionKind, type Source } from "./types";

// --------------------------------------------------------------------------
// Evidence, as a person reads it (SPEC §9: "quotes labelled 'You, Sep 1',
// tasks labelled 'Done Sep 1' or 'Still open', each with its full title")
// --------------------------------------------------------------------------

export type EvidenceView = {
  type: Source["type"];
  id: string;
  /** "You, Sep 1", "Done Sep 1", "Still open", "Remembered Aug 19", ... */
  label: string;
  /** The quote or the full title. Never cut, except a message body (see cutQuote). */
  text: string;
  /** "due Aug 21 · 0 of 4 steps · my suggestion" for a task; a task's quote as "note: ..." */
  meta?: string;
  /** Only documents link out; everything else is read in place. */
  href?: string;
};

export type KindLabel = "Need to know" | "Doesn't add up" | "Done yet?";

export const KIND_LABELS: Record<QuestionKind, KindLabel> = {
  need_to_know: "Need to know",
  doesnt_add_up: "Doesn't add up",
  done_yet: "Done yet?",
};

export type QuestionView = QuestionRow & { evidenceView: EvidenceView[]; kindLabel: KindLabel };

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
const OPEN_QUESTION_STATUSES = ["open", "asked"] as const;

/** One hero and up to seven rows (SPEC §9). The rest keep their rank and wait. */
const QUEUE_LIMIT = 8;
const PAST_DUE_LIMIT = 50;
const COMING_UP_LIMIT = 20;
const DUE_TODAY_LIMIT = 50;

/** "Sep 1" in the user's own calendar, never the server's. */
function monDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(d);
}

const QUOTE_MAX = 300;

/**
 * The ONE place a cut is allowed on Today (SPEC §9 "Nothing is cut off"): a
 * message body is a transcript turn, not a title, and one can run to a page.
 * Cut on a word boundary, and only mark it when something was actually cut.
 */
export function cutQuote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= QUOTE_MAX) return trimmed;
  const head = trimmed.slice(0, QUOTE_MAX);
  const lastSpace = head.lastIndexOf(" ");
  const whole = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${whole.trimEnd()}…`;
}

type Stage = { name?: string; done?: boolean };

function stepsMeta(stages: unknown): string | null {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const done = (stages as Stage[]).filter((s) => s?.done).length;
  return `${done} of ${stages.length} steps`;
}

/** Every evidence id of one type across a set of questions, deduplicated. */
function idsOfType(rows: QuestionRow[], type: Source["type"]): string[] {
  const ids = new Set<string>();
  for (const row of rows) for (const s of row.evidence) if (s.type === type) ids.add(s.id);
  return [...ids];
}

/**
 * Resolve the evidence of several questions with ONE query per source type,
 * every query scoped to the user. An id the user does not own, or that no
 * longer exists, is skipped in silence: a question is never blanked because
 * one of its sources was deleted, and nothing about another user's rows
 * (not even their absence) is ever shown.
 */
export async function viewQuestions(
  userId: string,
  rows: QuestionRow[],
  timezone: string
): Promise<QuestionView[]> {
  const taskIds = idsOfType(rows, "task");
  const memoryIds = idsOfType(rows, "memory");
  const messageIds = idsOfType(rows, "message");
  const eventIds = idsOfType(rows, "event");
  const documentIds = idsOfType(rows, "document");
  const expectationIds = idsOfType(rows, "expectation");

  const [taskRows, memoryRows, messageRows, eventRows, documentRows, expectationRows] =
    await Promise.all([
      taskIds.length
        ? db
            .select({
              id: tasks.id,
              title: tasks.title,
              status: tasks.status,
              dueAt: tasks.dueAt,
              completedAt: tasks.completedAt,
              updatedAt: tasks.updatedAt,
              stages: tasks.stages,
              source: tasks.source,
            })
            .from(tasks)
            .where(and(eq(tasks.userId, userId), inArray(tasks.id, taskIds)))
        : [],
      memoryIds.length
        ? db
            .select({ id: memories.id, fact: memories.fact, createdAt: memories.createdAt })
            .from(memories)
            .where(and(eq(memories.userId, userId), inArray(memories.id, memoryIds)))
        : [],
      messageIds.length
        ? db
            .select({ id: messages.id, content: messages.content, createdAt: messages.createdAt })
            .from(messages)
            .where(and(eq(messages.userId, userId), inArray(messages.id, messageIds)))
        : [],
      eventIds.length
        ? db
            .select({ id: events.id, title: events.title, startsAt: events.startsAt })
            .from(events)
            .where(and(eq(events.userId, userId), inArray(events.id, eventIds)))
        : [],
      documentIds.length
        ? db
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(and(eq(documents.userId, userId), inArray(documents.id, documentIds)))
        : [],
      expectationIds.length
        ? db
            .select({
              id: expectations.id,
              commitment: expectations.commitment,
              expectedUpdateBy: expectations.expectedUpdateBy,
            })
            .from(expectations)
            .where(and(eq(expectations.userId, userId), inArray(expectations.id, expectationIds)))
        : [],
    ]);

  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((r) => [r.id, r]));
  const task = byId(taskRows);
  const memory = byId(memoryRows);
  const message = byId(messageRows);
  const event = byId(eventRows);
  const document = byId(documentRows);
  const expectation = byId(expectationRows);

  const view = (s: Source): EvidenceView | null => {
    switch (s.type) {
      case "task": {
        const t = task.get(s.id);
        if (!t) return null;
        const label =
          t.status === "done"
            ? `Done ${monDay(t.completedAt ?? t.updatedAt, timezone)}`
            : t.status === "dropped"
              ? `Dropped ${monDay(t.updatedAt, timezone)}`
              : "Still open";
        // The full title is the text (SPEC §9: "each with its full title");
        // a quote from a task is from its notes and reads as a note under it.
        const meta = [
          t.dueAt ? `due ${monDay(t.dueAt, timezone)}` : null,
          stepsMeta(t.stages),
          t.source === "suggested" ? "my suggestion" : null,
          s.quote ? `note: ${s.quote}` : null,
        ].filter((m): m is string => m !== null);
        return {
          type: s.type,
          id: s.id,
          label,
          text: t.title,
          ...(meta.length ? { meta: meta.join(" · ") } : {}),
        };
      }
      case "memory": {
        const m = memory.get(s.id);
        if (!m) return null;
        return {
          type: s.type,
          id: s.id,
          label: `Remembered ${monDay(m.createdAt, timezone)}`,
          text: s.quote ?? m.fact,
        };
      }
      case "message": {
        const m = message.get(s.id);
        if (!m) return null;
        return {
          type: s.type,
          id: s.id,
          label: `You, ${monDay(m.createdAt, timezone)}`,
          text: s.quote ?? cutQuote(m.content),
        };
      }
      case "event": {
        const e = event.get(s.id);
        if (!e) return null;
        return {
          type: s.type,
          id: s.id,
          label: `Event ${monDay(e.startsAt, timezone)}`,
          text: e.title,
          ...(s.quote ? { meta: `note: ${s.quote}` } : {}),
        };
      }
      case "document": {
        const d = document.get(s.id);
        if (!d) return null;
        return {
          type: s.type,
          id: s.id,
          label: "Document",
          text: d.title,
          ...(s.quote ? { meta: `note: ${s.quote}` } : {}),
          href: `/documents/${s.id}`,
        };
      }
      case "expectation": {
        const x = expectation.get(s.id);
        if (!x) return null;
        return {
          type: s.type,
          id: s.id,
          label: `Expected by ${monDay(x.expectedUpdateBy, timezone)}`,
          text: s.quote ?? x.commitment,
        };
      }
    }
  };

  return rows.map((row) => ({
    ...row,
    kindLabel: KIND_LABELS[row.kind],
    evidenceView: row.evidence.map(view).filter((v): v is EvidenceView => v !== null),
  }));
}

/** One question with its evidence resolved; the question page and GET /api/questions/[id]. */
export async function viewQuestion(
  userId: string,
  row: QuestionRow,
  timezone: string
): Promise<QuestionView> {
  const [view] = await viewQuestions(userId, [row], timezone);
  return view;
}

// --------------------------------------------------------------------------
// Today
// --------------------------------------------------------------------------

export type TodayData = {
  todayLine: string;
  hero: QuestionView | null;
  questions: QuestionView[];
  counts: {
    /** Every open or asked question of the three kinds, shown or waiting. */
    questions: number;
    /** Past-due tasks that are the user's own: suggestions are not in this number (SPEC §10). */
    pastDue: number;
    /** Past-due tasks the app suggested and the user never took up. */
    pastDueSuggested: number;
    dueToday: number;
  };
  dueToday: BoundRow[];
  /** The user's own past-due tasks, soonest due first, fifty at most; suggestions are counted, not listed. */
  pastDue: BoundRow[];
  comingUp: BoundRow[];
  /** When any record was last written, ISO; null before the first run. */
  updatedAt: string | null;
  /**
   * When a run last finished, any status, ISO; null before the first. What
   * the thinking bars watch after an answer (components/today/thinking.tsx):
   * a re-read that failed finishes too, and the bars end with it rather
   * than running out their minute. The same stamp the Interview carries.
   */
  lastRunAt: string | null;
};

type RecordWords = { projectId: string; todayLine: string; updatedAt: Date };

/**
 * SPEC §7: the Today line "is written by the project that owns the nearest
 * dated item". Among the records that carry a line, the project with the
 * soonest open task due or event starting at or after the start of the local
 * day wins; a tie goes to the record written most recently. A project whose
 * line rests on nothing dated is not a candidate — its line is about nothing
 * that is coming — and with no candidate the caller falls back to the
 * mechanical line.
 */
async function pickTodayLine(
  userId: string,
  candidates: RecordWords[],
  dayStart: Date
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const projectIds = candidates.map((c) => c.projectId);

  const [taskSoonest, eventSoonest] = await Promise.all([
    db
      .select({ projectId: tasks.projectId, at: sql<string>`min(${tasks.dueAt})` })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.projectId, projectIds),
          inArray(tasks.status, [...OPEN_STATUSES]),
          isNotNull(tasks.dueAt),
          gte(tasks.dueAt, dayStart)
        )
      )
      .groupBy(tasks.projectId),
    db
      .select({ projectId: events.projectId, at: sql<string>`min(${events.startsAt})` })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          inArray(events.projectId, projectIds),
          gte(events.startsAt, dayStart)
        )
      )
      .groupBy(events.projectId),
  ]);

  const soonest = new Map<string, number>();
  for (const r of [...taskSoonest, ...eventSoonest]) {
    if (!r.projectId) continue;
    const t = new Date(r.at).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = soonest.get(r.projectId);
    if (prev === undefined || t < prev) soonest.set(r.projectId, t);
  }

  const ranked = candidates
    .filter((c) => soonest.has(c.projectId))
    .sort(
      (a, b) =>
        soonest.get(a.projectId)! - soonest.get(b.projectId)! ||
        b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  return ranked[0]?.todayLine ?? null;
}

/** SPEC §7: the fallback when no project owns the day. Days as digits. */
export function mechanicalTodayLine(dueToday: number): string {
  return dueToday === 0 ? "Nothing is due today." : `${dueToday} due today.`;
}

/**
 * Showing a question is asking it (SPEC §5). Rows returned for the first time
 * get surfacedAt = now, and each project's record logs { questionId, askedAt }
 * so the next run knows what the user has seen. The UPDATE filters on
 * surfaced_at IS NULL and only the rows it actually flipped are logged, so
 * two requests racing on a fresh question log it once, not twice.
 *
 * Exported because the voice briefing (lib/secretary/briefing.ts) surfaces
 * the same queue and must mark it the same way; there is one meaning of
 * "asked", not one per surface.
 */
export async function markSurfaced(
  userId: string,
  rows: QuestionRow[],
  now: Date
): Promise<Set<string>> {
  const fresh = rows.filter((r) => r.surfacedAt === null).map((r) => r.id);
  if (fresh.length === 0) return new Set();
  const flipped = await db
    .update(clarifications)
    .set({ surfacedAt: now })
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.id, fresh),
        sql`${clarifications.surfacedAt} is null`
      )
    )
    .returning({
      id: clarifications.id,
      projectId: clarifications.projectId,
      question: clarifications.question,
      evidence: clarifications.evidence,
    });

  const byProject = new Map<string, Asked[]>();
  for (const row of flipped) {
    if (!row.projectId) continue;
    const list = byProject.get(row.projectId) ?? [];
    // The text and the rows, not just the id: the next run reads this list
    // to know what was already put to the user, and an id alone told it
    // nothing, which is how the same question came back in new words.
    list.push({
      questionId: row.id,
      question: row.question.slice(0, 400),
      evidence: (row.evidence ?? []).slice(0, 40).map((s) => `${s.type}:${s.id}`),
      askedAt: now.toISOString(),
    });
    byProject.set(row.projectId, list);
  }
  for (const [projectId, entries] of byProject) {
    await upsertAsked(userId, projectId, entries);
  }
  return new Set(flipped.map((r) => r.id));
}

export async function buildToday(
  userId: string,
  timezone: string,
  now: Date = new Date()
): Promise<TodayData> {
  const { start } = dayRangeInTz(timezone, now);

  const [queue, [{ open }], [pastDueCounts], dueToday, pastDueAll, comingUp, recordRows, [lastRun]] = await Promise.all([
    listQuestions(userId, { limit: QUEUE_LIMIT }),
    db
      .select({ open: count() })
      .from(clarifications)
      .where(
        and(
          eq(clarifications.userId, userId),
          inArray(clarifications.kind, [...QUESTION_KINDS]),
          inArray(clarifications.status, [...OPEN_QUESTION_STATUSES])
        )
      ),
    // The past-due numbers, counted over every past-due task rather than
    // the listed fifty, split the way SPEC §10 splits them: the user's own
    // work in one, the app's untaken suggestions in the other. The same
    // filter the tasks binding applies for { open: true, due: "overdue" }.
    db
      .select({
        own: sql<number>`count(*) filter (where ${tasks.source} <> 'suggested')`.mapWith(Number),
        suggested: sql<number>`count(*) filter (where ${tasks.source} = 'suggested')`.mapWith(Number),
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.status, [...OPEN_STATUSES]),
          isNotNull(tasks.dueAt),
          lt(tasks.dueAt, start)
        )
      ),
    resolveBinding(
      userId,
      { source: "tasks", where: { open: true, due: "today" }, limit: DUE_TODAY_LIMIT },
      timezone,
      now
    ),
    // Soonest due first (the resolver's default order), fifty at most: past
    // the fifty the list is a backlog, not a day.
    resolveBinding(
      userId,
      { source: "tasks", where: { open: true, due: "overdue" }, sort: "due", limit: PAST_DUE_LIMIT },
      timezone,
      now
    ),
    // "week" on the events source is today through the next six days.
    resolveBinding(
      userId,
      { source: "events", where: { due: "week" }, limit: COMING_UP_LIMIT },
      timezone,
      now
    ),
    db
      .select({ projectId: records.projectId, words: records.words, updatedAt: records.updatedAt })
      .from(records)
      .where(eq(records.userId, userId)),
    db
      .select({ at: max(understandingRuns.finishedAt) })
      .from(understandingRuns)
      .where(eq(understandingRuns.userId, userId)),
  ]);

  const views = await viewQuestions(userId, queue, timezone);
  const surfaced = await markSurfaced(userId, queue, now);
  const shown = views.map((v) => (surfaced.has(v.id) ? { ...v, surfacedAt: now } : v));

  // SPEC §10: a suggestion never makes the past-due number bigger. The
  // suggested rows are left out of the list and counted only for the "N
  // suggestions" line. The list is the first fifty by due date minus the
  // suggestions among them; the numbers come from the count above, so a
  // backlog past fifty is still counted whole.
  const pastDue = pastDueAll.filter((r) => r.fields.source !== "suggested");

  const candidates: RecordWords[] = recordRows.flatMap((r) => {
    const line = r.words?.todayLine;
    return typeof line === "string" && line.trim() !== ""
      ? [{ projectId: r.projectId, todayLine: line.trim(), updatedAt: r.updatedAt }]
      : [];
  });
  const todayLine =
    (await pickTodayLine(userId, candidates, start)) ?? mechanicalTodayLine(dueToday.length);

  const updatedAt = recordRows.reduce<Date | null>(
    (max, r) => (max === null || r.updatedAt > max ? r.updatedAt : max),
    null
  );
  const lastRunAt = lastRun?.at ? new Date(lastRun.at) : null;

  return {
    todayLine,
    hero: shown[0] ?? null,
    questions: shown.slice(1),
    counts: {
      questions: open,
      pastDue: pastDueCounts.own,
      pastDueSuggested: pastDueCounts.suggested,
      dueToday: dueToday.length,
    },
    dueToday,
    pastDue,
    comingUp,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    lastRunAt: lastRunAt && !Number.isNaN(lastRunAt.getTime()) ? lastRunAt.toISOString() : null,
  };
}

// --------------------------------------------------------------------------
// The Interview (app/(app)/interview): every open question, one at a time
// --------------------------------------------------------------------------

export type InterviewData = {
  /** Every open or asked question of the three kinds across all projects, rank first, then oldest. */
  queue: QuestionView[];
  total: number;
  /** Questions of the three kinds answered today, on the user's own calendar. */
  answeredToday: number;
  /** When a run last finished, ISO; null before the first. */
  lastRunAt: string | null;
};

/**
 * Questions of the three kinds answered between two instants. The time an
 * answer landed is kept on the project's record, in asked[].answeredAt
 * (SPEC §5, written by answer.ts), so that is what is counted: one asked
 * entry per resolved question of the three kinds whose answeredAt falls in
 * the window. (clarifications.resolved_at marks every way a row leaves
 * pending, a dismissal or a supersession included, so it is not "answered".)
 * A question whose project has no record is not counted; every question
 * comes from a run, and a run writes the record before the questions, so
 * that is a row seeded by hand.
 */
async function countAnswered(userId: string, start: Date, end: Date): Promise<number> {
  const kinds = sql.join(
    QUESTION_KINDS.map((k) => sql`${k}`),
    sql`, `
  );
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(
      sql`${records} r
        cross join lateral jsonb_array_elements(coalesce(r.body->'asked', '[]'::jsonb)) as asked(entry)
        join ${clarifications} c on c.id = asked.entry->>'questionId' and c.user_id = r.user_id`
    )
    .where(
      and(
        sql`r.user_id = ${userId}`,
        sql`c.status = 'resolved'`,
        sql`c.kind in (${kinds})`,
        sql`(asked.entry->>'answeredAt')::timestamptz >= ${start.toISOString()}::timestamptz`,
        sql`(asked.entry->>'answeredAt')::timestamptz < ${end.toISOString()}::timestamptz`
      )
    );
  return row?.n ?? 0;
}

/**
 * What the Interview reads: the whole open queue in Today's order, with the
 * evidence of every question resolved, so the screen can move from one to
 * the next without a round trip. Only the question the screen shows is
 * marked surfaced (SPEC §5: showing a question is asking it), because the
 * Interview shows one at a time: the front of the queue, or, after "Skip for
 * now" moved that one to the back on the screen, the one the client names
 * as `front`. The rest are marked as they reach the front on a later read,
 * or by the answer path when answered first.
 */
export async function buildInterview(
  userId: string,
  timezone: string,
  now: Date = new Date(),
  opts: { front?: string } = {}
): Promise<InterviewData> {
  const { start, end } = dayRangeInTz(timezone, now);
  const [queue, answeredToday, [last]] = await Promise.all([
    listQuestions(userId),
    countAnswered(userId, start, end),
    db
      .select({ at: max(understandingRuns.finishedAt) })
      .from(understandingRuns)
      .where(eq(understandingRuns.userId, userId)),
  ]);
  const views = await viewQuestions(userId, queue, timezone);
  // A `front` that is no longer in the queue (answered elsewhere) falls back
  // to the real front, which is what the client shows once it has this.
  const front = queue.find((q) => q.id === opts.front) ?? queue[0];
  const surfaced = await markSurfaced(userId, front ? [front] : [], now);
  const shown = views.map((v) => (surfaced.has(v.id) ? { ...v, surfacedAt: now } : v));
  const lastAt = last?.at ? new Date(last.at) : null;
  return {
    queue: shown,
    total: shown.length,
    answeredToday,
    lastRunAt: lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt.toISOString() : null,
  };
}
