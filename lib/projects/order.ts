// His project order (docs/projects/SPEC.md §2): one move, whatever made it,
// the drag on the Projects tab (app/api/projects/order), its arrow keys, or
// "move Garden shed to the top" in the chat or on a call (move_project). A
// project goes to a place in its group and stays there: it, and every project
// above it in that group, are placed, in the order they now stand; the
// unplaced ones below keep the urgency order. It asks no model: the order is
// not in the signals the planner is asked about (§3). His moves are applied
// one at a time, in the order they arrived; a move waiting its turn holds no
// database connection, and a move reads only through its own transaction.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, user } from "@/lib/db/schema";
import { getPlanHead } from "@/lib/layout/plan-store";
import { matchProjectName } from "@/lib/project-names";
import { listProjects, type ProjectGroup, type ProjectListRow } from "./list";

export type MoveTo = "top" | "bottom" | "up" | "down" | { index: number } | { above: string } | { below: string };

export type MoveResult =
  | {
      ok: true;
      projectId: string;
      name: string;
      group: ProjectGroup;
      /** 1 at the top of its group. */
      place: number;
      of: number;
      /** The group's projects, in the order they now stand. */
      order: string[];
      /** What to tell him, in his words. */
      says: string;
      /** Its card on the Overview is one he placed there himself, and stays where he put it (§4). */
      overviewCardStays: boolean;
    }
  | { ok: false; error: string };

const GROUP_WORDS: Record<ProjectGroup, string> = { active: "your projects", lists: "your lists", set_aside: "your projects set aside" };
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** A project of his named by its id, or by a name the way every other tool matches one. */
function find(rows: ProjectListRow[], ref: string): ProjectListRow | null {
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const hit = matchProjectName(ref, rows.map((r) => r.name));
  return hit ? rows[hit.index] : null;
}

/**
 * His moves in this process, one at a time, in the order they arrived (§2). A move waits here, holding nothing,
 * until the one before it has finished; on 2b212e5 each waited at the row lock holding a connection, and with six
 * waiting (eight function calls of one reply on a call) the one holding the lock never got a connection to read
 * with, and nothing answered again.
 */
const turns = new Map<string, Promise<void>>();
function inTurn<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const before = turns.get(userId) ?? Promise.resolve();
  const mine = before.then(run);
  const done = mine.then(
    () => {},
    () => {}
  );
  turns.set(userId, done);
  void done.then(() => {
    if (turns.get(userId) === done) turns.delete(userId);
  });
  return mine;
}

export function moveProject(userId: string, project: string, to: MoveTo): Promise<MoveResult> {
  return inTurn(userId, () => applyMove(userId, project, to));
}

async function applyMove(userId: string, project: string, to: MoveTo): Promise<MoveResult> {
  const [who] = await db.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId));
  const timezone = who?.timezone ?? "UTC";
  const result = await db.transaction(async (tx) => {
    // His rows are locked before the order is read, so a move from another process cannot interleave with this
    // one into an order neither asked for (§2). The read comes after the lock, through this transaction (no second
    // connection), and sees the last move's write.
    await tx.execute(sql`select id from ${projects} where ${projects.userId} = ${userId} for update`);
    const rows = await listProjects(userId, timezone, new Date(), tx);
    const mine = find(rows, project);
    if (!mine) return { ok: false as const, error: `No project matching "${project}"` };
    const members = rows.filter((r) => r.group === mine.group);
    const others = members.filter((r) => r.id !== mine.id);
    const at = members.indexOf(mine);
    let index: number;
    if (typeof to === "string") {
      index = { top: 0, bottom: others.length, up: Math.max(0, at - 1), down: Math.min(others.length, at + 1) }[to];
    } else if ("index" in to) {
      index = Math.max(0, Math.min(others.length, Math.floor(to.index)));
    } else {
      const ref = "above" in to ? to.above : to.below;
      const other = find(rows, ref);
      if (!other) return { ok: false as const, error: `No project matching "${ref}"` };
      if (other.id === mine.id) return { ok: false as const, error: `"${mine.name}" cannot be placed next to itself` };
      if (other.group !== mine.group) {
        return { ok: false as const, error: `"${mine.name}" and "${other.name}" are not in the same group (${other.kind === "list" ? `"${other.name}" is a list` : `"${other.name}" is ${other.group === "active" ? "active" : "set aside"}`}); a project moves among its own group` };
      }
      index = others.indexOf(other) + ("below" in to ? 1 : 0);
    }
    const order = [...others];
    order.splice(index, 0, mine);
    // It and everything above it are placed; so is anything placed before (the placed ones are always a prefix).
    const placed = Math.max(index + 1, order.filter((r) => r.position !== null || r.id === mine.id).length);
    for (const [i, r] of order.entries()) {
      const want = i < placed ? i : null;
      if (r.position !== want) {
        await tx.update(projects).set({ position: want }).where(and(eq(projects.id, r.id), eq(projects.userId, userId)));
      }
    }
    return { ok: true as const, mine, index, order };
  });
  if (!result.ok) return result;
  const { mine, index, order } = result;
  const head = await getPlanHead(userId);
  const overviewCardStays = Boolean(head?.pinned.includes(`project_card:${mine.id}`));
  const words = GROUP_WORDS[mine.group];
  const where =
    index === 0 ? `is at the top of ${words}` : index === order.length - 1 ? `is at the bottom of ${words}` : `is now ${ORDINALS[index] ?? `number ${index + 1}`} in ${words}`;
  return {
    ok: true,
    projectId: mine.id,
    name: mine.name,
    group: mine.group,
    place: index + 1,
    of: order.length,
    order: order.map((r) => r.name),
    says: `${mine.name} ${where}.${overviewCardStays ? " On the Overview, its card stays where you put it." : ""}`,
    overviewCardStays,
  };
}
