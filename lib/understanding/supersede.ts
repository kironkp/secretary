// What an answer does to the OTHER questions — the event-driven half of the
// clarification flow.
//
// An answer applies writes to rows. Every other pending question that rests
// on one of those rows now asks about a premise the user just changed: the
// "check what is blocking CPO 2073" question after "close the old 2073 copy".
// Waiting for the model re-read to notice that takes a minute, and in that
// minute the user can answer an obsolete question. So the moment the writes
// apply, those questions are marked superseded, here, mechanically, and the
// next fetch of Today no longer shows them. The re-read then drafts from the
// data as it is; if the issue genuinely remains, it comes back with fresh
// evidence, and only then.
//
// The second half is the guard that keeps ruled-on issues from returning in
// new words: every row a resolved, dismissed or superseded question rested on
// is "settled", for that question's kind, at the moment it closed. A draft of
// the same kind whose rows are all settled, none of them changed since, and
// that carries no new message or memory, is the same issue again and is
// skipped. A row edited after the settlement, or a new message, is new
// evidence, and the issue may reopen. The kind is part of it because it is
// part of a question's identity (questions.ts): "is this done?" about a task
// is not "is this on the list twice?" about the same task, and a ruling on
// the second must not silence the first for a month.
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications } from "@/lib/db/schema";
import { QUESTION_KINDS, type Source, type Write } from "./types";

/** db, or the transaction an answer runs in. */
type Executor = Pick<typeof db, "select" | "update">;

export type ChangedRow = { type: "task" | "expectation"; id: string };

/** The rows a list of writes changes; resolve and remember_fact touch none. */
export function changedRowsOf(writes: Write[]): ChangedRow[] {
  const seen = new Set<string>();
  const out: ChangedRow[] = [];
  for (const w of writes) {
    let row: ChangedRow | null = null;
    if ("taskId" in w) row = { type: "task", id: w.taskId };
    else if ("expectationId" in w) row = { type: "expectation", id: w.expectationId };
    if (!row) continue;
    const key = `${row.type}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Mark every other pending question of the user's that rests on one of the
 * changed rows as superseded by `answeredId`. Returns the ids it changed.
 * Scoped to the user, not the project: a row belongs to one project, so the
 * questions resting on it are in that project anyway, and a question filed
 * under the wrong project is still about that row.
 */
export async function supersedeByWrites(
  executor: Executor,
  userId: string,
  answeredId: string,
  changed: ChangedRow[],
  now: Date
): Promise<string[]> {
  if (changed.length === 0) return [];
  const pending = await executor
    .select({ id: clarifications.id, evidence: clarifications.evidence })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.status, ["open", "asked"]),
        inArray(clarifications.kind, [...QUESTION_KINDS])
      )
    );
  const changedKeys = new Set(changed.map((r) => `${r.type}:${r.id}`));
  const hit = pending
    .filter((q) => q.id !== answeredId)
    .filter((q) => (q.evidence ?? []).some((s) => changedKeys.has(`${s.type}:${s.id}`)))
    .map((q) => q.id);
  if (hit.length === 0) return [];
  await executor
    .update(clarifications)
    .set({
      status: "superseded",
      supersededBy: answeredId,
      resolvedAt: now,
      resolution: "premise changed by an answer",
    })
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.id, hit),
        inArray(clarifications.status, ["open", "asked"])
      )
    );
  return hit;
}

/** How long a ruled-on row stays settled without new evidence. */
export const SETTLED_DAYS = 30;

/** The settled map's key: a row, under the kind of the question that rested on it. */
export function settledKey(kind: string, source: { type: string; id: string }): string {
  return `${kind} ${source.type}:${source.id}`;
}

/**
 * Every evidence key of the user's questions that closed in the last
 * SETTLED_DAYS, under each question's kind, with the latest moment it was
 * ruled on. Resolved, dismissed and superseded all count: each is a person
 * or the loop deciding that the issue on those rows was seen. The one
 * dismissal that is not a ruling is a text twin ("duplicate of <id>"): the
 * row that was kept carries the ruling, and the twin's own rows, which may
 * differ, were never decided on, so they do not settle.
 */
export async function settledEvidence(
  executor: Executor,
  userId: string,
  now: Date
): Promise<Map<string, Date>> {
  const since = new Date(now.getTime() - SETTLED_DAYS * 86_400_000);
  const rows = await executor
    .select({
      kind: clarifications.kind,
      evidence: clarifications.evidence,
      resolvedAt: clarifications.resolvedAt,
      createdAt: clarifications.createdAt,
    })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.status, ["resolved", "dismissed", "superseded"]),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        sql`coalesce(${clarifications.resolution}, '') not like 'duplicate of %'`,
        // resolved_at is new; older rows fall back to created_at, which is
        // earlier than the truth and therefore errs toward asking again.
        gt(sql`coalesce(${clarifications.resolvedAt}, ${clarifications.createdAt})`, since)
      )
    );
  const settled = new Map<string, Date>();
  for (const r of rows) {
    const at = r.resolvedAt ?? r.createdAt;
    for (const s of r.evidence ?? []) {
      const key = settledKey(r.kind, s);
      const prev = settled.get(key);
      if (!prev || prev < at) settled.set(key, at);
    }
  }
  return settled;
}

/**
 * Is this draft the same issue again? True when every row it rests on was
 * settled by a question of the same kind and none changed after its
 * settlement. A message or memory the settled set has never seen is new
 * evidence, and so is a task or expectation whose updatedAt is later than
 * the moment it was ruled on. A draft with no evidence at all is never
 * "already ruled on" (the validator refuses it anyway).
 */
export function isAlreadyRuledOn(
  kind: string,
  evidence: Source[],
  settled: Map<string, Date>,
  updatedAtOf: (key: string) => Date | null
): boolean {
  if (evidence.length === 0) return false;
  for (const s of evidence) {
    const at = settled.get(settledKey(kind, s));
    if (!at) return false;
    const changed = updatedAtOf(`${s.type}:${s.id}`);
    if (changed && changed > at) return false;
  }
  return true;
}
