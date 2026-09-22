// The record's `asked` log — docs/understanding/SPEC.md §2 and §5.
//
// `asked[]` is the one part of a project's record the code writes and the
// model never does (run.ts replaces whatever the model returned there with
// the stored list). Two paths write it: Today, when it first shows a question
// (SPEC §5: "asked" means surfaced), and the answer endpoint, when the user
// picks an answer. Both go through here so the write is one atomic UPDATE in
// SQL rather than a read-modify-write in JS: two answers landing on the same
// project at once (a tap and a spoken answer) must not lose each other.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { records } from "@/lib/db/schema";
import type { Asked } from "./types";

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
