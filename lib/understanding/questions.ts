// Questions: identity, rank, storage — docs/understanding/SPEC.md §5.
//
// The model proposes; this file decides. Rank is mechanical so the model
// cannot promote its own question, identity is a hash so the same question
// is never asked twice, and a row the model forgot one run is left alone
// unless the data it rested on changed. Every query filters on userId.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, entities, messages, projects } from "@/lib/db/schema";
import { termMatcher } from "./terms";
import {
  QUESTION_KINDS,
  type Answer,
  type Bundle,
  type QuestionDraft,
  type QuestionKind,
  type Source,
} from "./types";

/** The voice-flow kinds from lib/secretary/entities.ts; never surfaced on Today. */
export const ASR_KINDS = ["referent", "asr_span", "new_name", "entity_conflict"] as const;

const OPEN_STATUSES = ["open", "asked"] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** SPEC §5 tier 1: a dated evidence item this close to now makes the hero. */
const SOON_MS = 48 * HOUR_MS;

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/**
 * sha256 of (kind, sorted evidence keys). Order-independent, duplicate-blind:
 * the same evidence cited twice is the same question. This is what "never
 * ask twice about the same evidence" means mechanically.
 */
export function questionIdentity(draft: {
  kind: string;
  evidence: { type: string; id: string }[];
}): string {
  const keys = [...new Set(draft.evidence.map((e) => `${e.type}:${e.id}`))].sort();
  return createHash("sha256").update(`${draft.kind}\n${keys.join("\n")}`).digest("hex");
}

// --------------------------------------------------------------------------
// Rank
// --------------------------------------------------------------------------

/** Tier bases. Lower sorts first; Today reads rank ascending. */
const TIER = { hero: 0, needToKnow: 100, doesntAddUp: 200, doneYet: 300 } as const;
/** Evidence beyond this counts no further; keeps the within-tier spread below 20. */
const MAX_COUNTED_EVIDENCE = 20;
/** done_yet: evidence older than this is "as old as it gets". */
const MAX_AGE_DAYS = 3650;
/** Room for the evidence tiebreak inside one age step. */
const AGE_STEP = 20;

/**
 * SPEC §5 ranking, mechanical and deterministic:
 *   0..     need_to_know with a task due or an event starting within 48 hours
 *           of now — the hero. Within 48 hours either way: a date that passed
 *           yesterday is as pressing as one tomorrow.
 *   100..   other need_to_know
 *   200..   doesnt_add_up, because a wrong list poisons every other sentence
 *   300..   done_yet, oldest evidence first (by the evidenced task's dueAt,
 *           else createdAt), then more evidence first
 * Within every tier, more evidence sorts first.
 */
export function rankDraft(draft: QuestionDraft, bundle: Bundle): number {
  const now = Date.parse(bundle.clock.nowIso);
  const evidenceIds = new Set(
    draft.evidence.filter((e) => e.type === "task").map((e) => e.id)
  );
  const eventIds = new Set(draft.evidence.filter((e) => e.type === "event").map((e) => e.id));
  const tasks = [...bundle.tasksOpen, ...bundle.tasksDone].filter((t) => evidenceIds.has(t.id));
  const events = bundle.events.filter((e) => eventIds.has(e.id));
  const penalty = MAX_COUNTED_EVIDENCE - Math.min(draft.evidence.length, MAX_COUNTED_EVIDENCE);

  const within48 = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && Math.abs(t - now) <= SOON_MS;
  };

  switch (draft.kind) {
    case "need_to_know": {
      const soon =
        tasks.some((t) => t.dueAt !== null && within48(t.dueAt)) ||
        events.some((e) => within48(e.startsAt));
      return (soon ? TIER.hero : TIER.needToKnow) + penalty;
    }
    case "doesnt_add_up":
      return TIER.doesntAddUp + penalty;
    case "done_yet": {
      const dates = tasks
        .map((t) => Date.parse(t.dueAt ?? t.createdAt))
        .filter((d) => Number.isFinite(d));
      // No dated task in the evidence: as new as it gets, so it sorts last.
      const oldest = dates.length ? Math.min(...dates) : now;
      const ageDays = Math.min(MAX_AGE_DAYS, Math.max(0, Math.floor((now - oldest) / DAY_MS)));
      return TIER.doneYet + (MAX_AGE_DAYS - ageDays) * AGE_STEP + penalty;
    }
  }
}

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

/**
 * Write one run's drafts for one project into `clarifications` (SPEC §5).
 *
 * - An identity already resolved or dismissed is skipped: asked once, never
 *   re-created. This is the memory of asking.
 * - An identity still open or asked is refreshed in place — wording, why,
 *   evidence, answers, rank — keeping its status and surfacedAt, so a
 *   question the user has seen does not become a new card.
 * - Anything else is inserted open.
 * - A second guard, by text (normalizeQuestionText). Identity stays
 *   evidence-based; this catches the same question asked from two evidence
 *   sets, or from two projects, which Today then showed as two rows. Drafts
 *   that refresh a row go before drafts that would insert one, so a
 *   question already on Today keeps its row and its wording wins:
 *     - a refresh whose text an open or asked row of the user's ALSO
 *       carries, in ANY project, dismisses that row as its duplicate
 *       ("duplicate of <id>"), so a pair that already exists is healed by
 *       the next run that re-proposes either of them, not frozen;
 *     - a refresh whose text another row kept THIS run already carries is
 *       itself the duplicate, and is dismissed the same way;
 *     - a new draft whose text a kept or standing row carries is skipped and
 *       reported in skippedDuplicates.
 *   The row a draft refreshes in place is never its own twin, and a text is
 *   free again once the row carrying it is resolved or dismissed.
 * - Rows of the three kinds for this project that this run did not propose
 *   are dismissed only when the data moved under them AFTER they were asked:
 *   an evidence task finished since the row was created (or gone from the
 *   bundle), or an evidence expectation cleared. A model that simply forgot
 *   a question one run must not make it flap, so a row whose evidence is as
 *   it was on the day it was asked stays exactly as it was.
 */
export async function syncQuestions(
  userId: string,
  projectId: string,
  drafts: QuestionDraft[],
  bundle: Bundle
): Promise<{ created: string[]; updated: string[]; dismissed: string[]; skippedDuplicates: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  const dismissed: string[] = [];
  const skippedDuplicates: string[] = [];
  const identities = new Set<string>();

  // Every open or asked question of the user's, by normalized text, for the
  // text guard: one read up front rather than one per draft.
  const standingByText = new Map<string, string[]>();
  const standingTexts = await db
    .select({ id: clarifications.id, question: clarifications.question })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        inArray(clarifications.status, [...OPEN_STATUSES])
      )
    );
  for (const row of standingTexts) {
    const key = normalizeQuestionText(row.question);
    standingByText.set(key, [...(standingByText.get(key) ?? []), row.id]);
  }
  /** The row that holds each text after this run's writes so far. */
  const keptByText = new Map<string, string>();
  /** Rows dismissed this run as duplicates: never a twin again, never refreshed. */
  const retired = new Set<string>();
  const retire = async (id: string, duplicateOf: string): Promise<void> => {
    await db
      .update(clarifications)
      .set({ status: "dismissed", resolution: `duplicate of ${duplicateOf}` })
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, id)));
    retired.add(id);
    dismissed.push(id);
  };

  // First the identity of every draft and the row it would refresh, so the
  // refreshes can go first (see the rule above); the text guard needs to
  // know which drafts those are before it writes anything.
  const pending: { draft: QuestionDraft; identity: string; existing: { id: string } | null }[] = [];
  for (const draft of drafts) {
    const identity = questionIdentity(draft);
    // The same question twice in one run: the first wins, the second is noise.
    if (identities.has(identity)) continue;
    identities.add(identity);

    const [existing] = await db
      .select({ id: clarifications.id, status: clarifications.status })
      .from(clarifications)
      .where(and(eq(clarifications.userId, userId), eq(clarifications.identity, identity)))
      .orderBy(desc(clarifications.createdAt))
      .limit(1);
    if (existing && (existing.status === "resolved" || existing.status === "dismissed")) continue;
    pending.push({ draft, identity, existing: existing ?? null });
  }
  const ordered = [...pending.filter((p) => p.existing), ...pending.filter((p) => !p.existing)];

  for (const { draft, identity, existing } of ordered) {
    const rank = rankDraft(draft, bundle);
    // The text guard. The row this draft would refresh (same identity) is
    // excluded: a question re-proposed with its own wording is not a twin
    // of itself.
    const text = normalizeQuestionText(draft.question);
    const twins = (standingByText.get(text) ?? []).filter(
      (id) => id !== existing?.id && !retired.has(id)
    );

    if (existing) {
      // Retired earlier this run, as the twin of a row that went first.
      if (retired.has(existing.id)) continue;
      const holder = keptByText.get(text);
      if (holder) {
        // Reworded into the words another row already holds after this
        // run's earlier writes: this row is the duplicate, that one stays.
        await retire(existing.id, holder);
        continue;
      }
      // Standing rows with these words are this row's duplicates, however
      // they came to be: the pair Today showed is closed here.
      for (const twin of twins) await retire(twin, existing.id);
      keptByText.set(text, existing.id);
    } else if (keptByText.has(text) || twins.length > 0) {
      skippedDuplicates.push(draft.question);
      continue;
    }

    if (existing) {
      await db
        .update(clarifications)
        .set({
          question: draft.question,
          context: draft.why,
          evidence: draft.evidence,
          answers: draft.answers,
          rank,
          projectId,
        })
        .where(and(eq(clarifications.userId, userId), eq(clarifications.id, existing.id)));
      updated.push(existing.id);
      continue;
    }

    const [row] = await db
      .insert(clarifications)
      .values({
        userId,
        kind: draft.kind,
        question: draft.question,
        context: draft.why,
        evidence: draft.evidence,
        answers: draft.answers,
        rank,
        identity,
        projectId,
        status: "open",
      })
      .returning({ id: clarifications.id });
    keptByText.set(text, row.id);
    created.push(row.id);
  }

  // --- the rows this run did not mention ----------------------------------
  // "Moved" means the data changed under the question AFTER it was asked. A
  // question may legitimately rest on a finished task — the duplicate-CPO
  // question cites the done copy (SPEC §1) — or on a missed follow-up, which
  // is one of done_yet's triggers (SPEC §5). Those were the evidence on the
  // day it was created, and the bundle never shows the model its open
  // questions, so a run that omits one must not turn its own evidence into a
  // dismissal. A task therefore counts as moved only when it was finished
  // after the row's created_at, or has left the bundle altogether (deleted,
  // or aged out of the 60-day window, so the model can no longer cite it);
  // an expectation only when it is no longer in the bundle at all, which is
  // cleared or deleted. Open to missed is the calendar passing, not the user
  // answering anything.
  const openTaskIds = new Set(bundle.tasksOpen.map((t) => t.id));
  const finishedAt = new Map(
    bundle.tasksDone.map((t) => [t.id, Date.parse(t.completedAt ?? t.updatedAt)])
  );
  const expectationIds = new Set(bundle.expectations.map((e) => e.id));
  const evidenceMoved = (s: Source, askedAt: Date): boolean => {
    if (s.type === "task") {
      if (openTaskIds.has(s.id)) return false;
      const done = finishedAt.get(s.id);
      if (done === undefined) return true;
      return Number.isNaN(done) || done >= askedAt.getTime();
    }
    if (s.type === "expectation") return !expectationIds.has(s.id);
    return false;
  };

  const standing = await db
    .select({
      id: clarifications.id,
      identity: clarifications.identity,
      evidence: clarifications.evidence,
      createdAt: clarifications.createdAt,
    })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        eq(clarifications.projectId, projectId),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        inArray(clarifications.status, [...OPEN_STATUSES])
      )
    );

  for (const row of standing) {
    if (row.identity && identities.has(row.identity)) continue;
    if (!row.evidence.some((s) => evidenceMoved(s, row.createdAt))) continue;
    await db
      .update(clarifications)
      .set({ status: "dismissed", resolution: "resolved by a change in the data" })
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, row.id)));
    dismissed.push(row.id);
  }

  return { created, updated, dismissed, skippedDuplicates };
}

/**
 * The text guard's key: case-blind, whitespace-collapsed, end punctuation
 * dropped, so "Is the statement done?" and "is the statement done" are one
 * question. Nothing subtler: two wordings of one question are the run's
 * identity to catch, and a guard that reached for synonyms would start
 * skipping questions that are really different.
 */
export function normalizeQuestionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?…]+$/u, "");
}

// --------------------------------------------------------------------------
// The ASR backlog (SPEC §5, last paragraph)
// --------------------------------------------------------------------------

const ASR_MESSAGE_DAYS = 90;
/** "Confirmed by use": the subject in this many of the user's own messages. */
const CONFIRMED_BY_USE = 3;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Dismiss open or asked rows of the four voice-flow kinds whose subject the
 * user has since confirmed — by an entity marked confirmed with that name or
 * alias, or by using the name in three or more of their own messages. A name
 * the user keeps saying is a name; "I heard CPO — is that CPS?" after the
 * fortieth CPO is noise. The three understanding kinds are never touched.
 * Returns how many rows were dismissed.
 */
export async function retireAsrClarifications(
  userId: string,
  opts?: { messages?: { content: string }[]; now?: Date }
): Promise<number> {
  // The 90-day window is measured from the run's clock, never the wall
  // clock, so a sweep with an injected `now` (and a test on fixed dates)
  // reads the same messages however long after the fact it runs.
  const now = opts?.now ?? new Date();
  const rows = await db
    .select({ id: clarifications.id, subject: clarifications.subject })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.kind, [...ASR_KINDS]),
        inArray(clarifications.status, [...OPEN_STATUSES]),
        isNotNull(clarifications.subject)
      )
    );
  if (rows.length === 0) return 0;

  const confirmed = await db
    .select({ name: entities.name, aliases: entities.aliases })
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.confirmed, true)));
  const known = new Set<string>();
  for (const e of confirmed) {
    known.add(norm(e.name));
    for (const alias of e.aliases) known.add(norm(alias));
  }

  const said =
    opts?.messages ??
    (await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          eq(messages.role, "user"),
          gte(messages.createdAt, new Date(now.getTime() - ASR_MESSAGE_DAYS * DAY_MS))
        )
      ));

  let retired = 0;
  for (const row of rows) {
    const subject = norm(row.subject ?? "");
    if (!subject) continue;
    let confirmedByUser = known.has(subject);
    if (!confirmedByUser) {
      // Whole words, case- and punctuation-blind: the same match the bundle
      // uses to find a project's mentions (lib/understanding/terms.ts).
      const mentions = termMatcher([row.subject ?? ""]);
      let n = 0;
      for (const m of said) {
        if (mentions(m.content) && ++n >= CONFIRMED_BY_USE) break;
      }
      confirmedByUser = n >= CONFIRMED_BY_USE;
    }
    if (!confirmedByUser) continue;
    await db
      .update(clarifications)
      .set({ status: "dismissed", resolution: "confirmed by use" })
      .where(and(eq(clarifications.userId, userId), eq(clarifications.id, row.id)));
    retired++;
  }
  return retired;
}

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

/** A question as Today and the answer endpoint read it (SPEC §9). */
export type QuestionRow = {
  id: string;
  kind: QuestionKind;
  question: string;
  why: string;
  evidence: Source[];
  answers: Answer[];
  rank: number;
  projectId: string | null;
  projectName: string | null;
  /** listQuestions returns open and asked only; getQuestion returns any, so
   *  the answer endpoint (SPEC §6 step 1) can refuse a resolved one by name. */
  status: "open" | "asked" | "resolved" | "dismissed";
  surfacedAt: Date | null;
  createdAt: Date;
};

const questionColumns = {
  id: clarifications.id,
  kind: clarifications.kind,
  question: clarifications.question,
  context: clarifications.context,
  evidence: clarifications.evidence,
  answers: clarifications.answers,
  rank: clarifications.rank,
  projectId: clarifications.projectId,
  projectName: projects.name,
  status: clarifications.status,
  surfacedAt: clarifications.surfacedAt,
  createdAt: clarifications.createdAt,
};

type QuestionSelect = {
  id: string;
  kind: string;
  question: string;
  context: string | null;
  evidence: Source[];
  answers: Answer[];
  rank: number;
  projectId: string | null;
  projectName: string | null;
  status: string;
  surfacedAt: Date | null;
  createdAt: Date;
};

const toQuestionRow = (r: QuestionSelect): QuestionRow => ({
  id: r.id,
  kind: r.kind as QuestionKind,
  question: r.question,
  why: r.context ?? "",
  evidence: r.evidence,
  answers: r.answers,
  rank: r.rank,
  projectId: r.projectId,
  projectName: r.projectName,
  status: r.status as QuestionRow["status"],
  surfacedAt: r.surfacedAt,
  createdAt: r.createdAt,
});

/**
 * The open queue: rows of the three understanding kinds, rank first, then
 * the oldest of equal rank. Today takes the first as the hero and the next
 * few as rows; the rest keep their rank and wait.
 */
export async function listQuestions(
  userId: string,
  opts?: { limit?: number }
): Promise<QuestionRow[]> {
  const base = db
    .select(questionColumns)
    .from(clarifications)
    .leftJoin(projects, and(eq(projects.id, clarifications.projectId), eq(projects.userId, userId)))
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        inArray(clarifications.status, [...OPEN_STATUSES])
      )
    )
    .orderBy(asc(clarifications.rank), asc(clarifications.createdAt));
  const rows = opts?.limit !== undefined ? await base.limit(opts.limit) : await base;
  return rows.map(toQuestionRow);
}

/** One question by id, any status, or null when it is not this user's. */
export async function getQuestion(userId: string, id: string): Promise<QuestionRow | null> {
  const [row] = await db
    .select(questionColumns)
    .from(clarifications)
    .leftJoin(projects, and(eq(projects.id, clarifications.projectId), eq(projects.userId, userId)))
    .where(
      and(
        eq(clarifications.userId, userId),
        eq(clarifications.id, id),
        inArray(clarifications.kind, [...QUESTION_KINDS])
      )
    )
    .limit(1);
  return row ? toQuestionRow(row) : null;
}
