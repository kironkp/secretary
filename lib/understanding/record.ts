// The record's `asked` log — docs/understanding/SPEC.md §2 and §5.
//
// `asked[]` is the one part of a project's record the code writes and the
// model never does (run.ts replaces whatever the model returned there with
// the stored list). Two paths write it: Today, when it first shows a question
// (SPEC §5: "asked" means surfaced), and the answer endpoint, when the user
// picks an answer. Both go through here so the write is one atomic UPDATE in
// SQL rather than a read-modify-write in JS: two answers landing on the same
// project at once (a tap and a spoken answer) must not lose each other.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, records } from "@/lib/db/schema";
import { QUESTION_KINDS, type Asked } from "./types";

/**
 * Replace-or-append: any existing entry for one of `entries`' questionIds is
 * removed (order of the rest preserved), then `entries` are appended. A
 * project with no record is left alone — there is nothing to write into, and
 * the next run starts its record from an empty `asked`.
 */
export async function upsertAsked(
  userId: string,
  projectId: string,
  entries: Asked[]
): Promise<void> {
  if (entries.length === 0) return;
  // One bound parameter per id: the sql template renders a JS array as a row
  // constructor, not a Postgres array, so `= any($1::text[])` cannot be used.
  const ids = sql.join(
    entries.map((e) => sql`${e.questionId}`),
    sql`, `
  );
  await db
    .update(records)
    .set({
      body: sql`jsonb_set(
        ${records.body},
        '{asked}',
        (
          select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb)
          from jsonb_array_elements(coalesce(${records.body}->'asked', '[]'::jsonb))
            with ordinality as t(e, i)
          where t.e->>'questionId' not in (${ids})
        ) || ${JSON.stringify(entries)}::jsonb
      )`,
    })
    .where(and(eq(records.userId, userId), eq(records.projectId, projectId)));
}

/**
 * Rebuild `asked` entries the record lost.
 *
 * Until 2026-09-23 a run wrote the record with the `asked` list it had read
 * before calling the model, so every answer given during those minutes was
 * erased (run.ts, where the merge now happens in SQL). The history is
 * recoverable: `clarifications` still holds each question's text, the rows
 * it rested on, what the user said and when it closed. For every project
 * this puts back an entry for each settled question the record no longer
 * mentions, and completes any entry that is an id with no question text or
 * no answer, so the next run sees what it already asked and what the user
 * said. Returns how many entries it wrote.
 */
export async function backfillAsked(userId: string, projectId: string): Promise<number> {
  const [record] = await db
    .select({ body: records.body })
    .from(records)
    .where(and(eq(records.userId, userId), eq(records.projectId, projectId)))
    .limit(1);
  if (!record) return 0;

  const existing = new Map((record.body.asked ?? []).map((a) => [a.questionId, a]));
  const settled = await db
    .select({
      id: clarifications.id,
      question: clarifications.question,
      evidence: clarifications.evidence,
      resolution: clarifications.resolution,
      resolvedAt: clarifications.resolvedAt,
      surfacedAt: clarifications.surfacedAt,
      createdAt: clarifications.createdAt,
    })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        eq(clarifications.projectId, projectId),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        inArray(clarifications.status, ["resolved", "dismissed", "superseded"])
      )
    );

  // Entries written before the asked list carried the question (2026-09-22)
  // are an id and nothing else: the model cannot tell what was asked, which
  // is no better than the entry being gone. Those are completed here too,
  // keeping the askedAt the record already had — it is the truth about when
  // the question was put to the user.
  const missing: Asked[] = [];
  for (const row of settled) {
    const had = existing.get(row.id);
    const needsText = !had?.question || (had.evidence ?? []).length === 0;
    const needsAnswer = Boolean(row.resolution) && !had?.answer;
    if (had && !needsText && !needsAnswer) continue;
    missing.push({
      ...had,
      questionId: row.id,
      question: row.question,
      evidence: row.evidence.map((s) => `${s.type}:${s.id}`),
      askedAt: had?.askedAt ?? (row.surfacedAt ?? row.createdAt).toISOString(),
      ...(row.resolution ? { answer: had?.answer ?? row.resolution } : {}),
      ...(row.resolvedAt ? { answeredAt: had?.answeredAt ?? row.resolvedAt.toISOString() } : {}),
    });
  }
  if (missing.length === 0) return 0;
  await upsertAsked(userId, projectId, missing);
  return missing.length;
}
