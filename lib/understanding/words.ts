// The words the Workspace reads — docs/understanding/SPEC.md §7 and §9.
//
// A run writes one lede per board widget its project owns and stores them on
// the project's record (`records.words.ledes`, keyed by widget id). The board
// never waits for a run (§8, "never on read"): it ships whatever ledes are
// stored, and marks the ones the world has moved past as stale so the client
// can dim them until the next sweep writes fresh ones.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { records, tasks } from "@/lib/db/schema";

export type Lede = {
  /** The lede as the run wrote it. Shown in full; never cut. */
  text: string;
  /**
   * True when a task of the lede's project changed after the record was
   * written (§7: "the client renders a stale lede dimmed until the fresh one
   * lands"). The text may still name a row that has since moved on.
   *
   * This is an approximation of "the inputs the lede was written from
   * changed", not the hash compare §7 describes. The exact answer is the
   * record's inputs_hash against a fresh hash of the bundle, and a bundle is
   * a gather (the board, the memories, the messages, every project's rows),
   * which the board's 15-second poll cannot afford; the hash is never
   * computed on read (§8, "never on read"). What the proxy sees: any task of
   * the owning project moving. What it misses: a row from ANOTHER project
   * entering or leaving a widget the owning project writes for (the default
   * Overdue widget spans every project; the owner is the plurality,
   * gather.ts widgetsByOwner), and events, which have no updated_at. Both
   * still change the bundle hash (widget row ids are part of it), so the
   * next sweep re-runs the owner and a fresh lede replaces this one within
   * UNDERSTANDING_SWEEP_MINUTES; the miss is a lede shown undimmed for those
   * minutes, never a wrong lede kept. Storing the widget's row ids on the
   * record at write time would make this exact for one field and no query.
   */
  stale: boolean;
  /** The project whose record carries this lede. */
  projectId: string;
};

/**
 * Every lede the user's records carry, keyed by widget id.
 *
 * Two records can name the same widget: ownership of a widget is attributed
 * per run (gather.ts widgetsByOwner), so when a widget's rows shift from one
 * project to another the old owner's record keeps its lede until its own next
 * run. The newer record wins, because it was written from the later state of
 * the board.
 *
 * Staleness is one grouped query over the user's tasks for the projects that
 * carry ledes, not one query per record: a board is read every 15 seconds by
 * every open tab, and the records of a user with many projects would
 * otherwise cost a round trip each on every poll.
 */
export async function ledesFor(userId: string): Promise<Record<string, Lede>> {
  const rows = await db
    .select({ projectId: records.projectId, words: records.words, updatedAt: records.updatedAt })
    .from(records)
    .where(eq(records.userId, userId));

  // A row from before the words column, or a run that wrote none, reads as
  // `{}` and contributes nothing.
  const carrying = rows.filter((r) => Object.keys(r.words?.ledes ?? {}).length > 0);
  if (carrying.length === 0) return {};

  const newest = await db
    .select({
      projectId: tasks.projectId,
      // mapWith the column so the driver's timestamp string becomes a Date
      // the same way it does for a plain column read.
      at: sql`max(${tasks.updatedAt})`.mapWith(tasks.updatedAt),
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(
          tasks.projectId,
          carrying.map((r) => r.projectId)
        )
      )
    )
    .groupBy(tasks.projectId);

  const newestTaskAt = new Map<string, number>();
  for (const r of newest) {
    if (r.projectId) newestTaskAt.set(r.projectId, r.at.getTime());
  }

  const out: Record<string, Lede> = {};
  const writtenAt = new Map<string, number>();
  for (const r of carrying) {
    const at = r.updatedAt.getTime();
    const latestTask = newestTaskAt.get(r.projectId);
    const stale = latestTask !== undefined && latestTask > at;
    for (const [widgetId, text] of Object.entries(r.words?.ledes ?? {})) {
      if (typeof text !== "string" || text.trim() === "") continue;
      const prev = writtenAt.get(widgetId);
      if (prev !== undefined && prev >= at) continue;
      out[widgetId] = { text, stale, projectId: r.projectId };
      writtenAt.set(widgetId, at);
    }
  }
  return out;
}
