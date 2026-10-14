// The Projects tab (SEC-A006): every project, what is open in it and when
// the next thing is due, counted the way every other screen counts (lib/due.ts:
// open work only, a suggestion still waiting is not counted). Since v1.11 in
// his order (docs/projects/SPEC.md §1): within each group, the one order the
// Overview's cards use, read off the same signals for the projects those
// carry, so the two screens cannot disagree.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";
import { daysFromToday, dueLabel, isOpenWork, isPastDue, OPEN_STATUSES } from "@/lib/due";
import { orderedOf } from "@/lib/layout/plan";
import { computeSignals } from "@/lib/layout/signals";
import { byOrder, type Ordered } from "@/lib/project-order";

/** The groups the Projects tab shows, in its order; a move stays inside one (docs/projects/SPEC.md §2). */
export type ProjectGroup = "active" | "lists" | "set_aside";
export const GROUPS: ProjectGroup[] = ["active", "lists", "set_aside"];
export const groupOf = (p: { kind: string; status: string }): ProjectGroup =>
  p.kind === "list" ? "lists" : p.status === "active" ? "active" : "set_aside";

export type ProjectListRow = {
  id: string;
  name: string;
  color: string | null;
  status: "active" | "someday" | "archived";
  kind: "project" | "list";
  group: ProjectGroup;
  /** His place for it in its group; empty when he has not placed it. */
  position: number | null;
  open: number;
  pastDue: number;
  /** How the soonest open due date reads ("2 days late", "Fri"); empty when nothing is dated. */
  next: string;
};

export async function listProjects(userId: string, timezone: string, now: Date = new Date()): Promise<ProjectListRow[]> {
  const [rows, open, signals] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, color: projects.color, status: projects.status, kind: projects.kind, position: projects.position, deadline: projects.deadline })
      .from(projects)
      .where(eq(projects.userId, userId)),
    db
      .select({ projectId: tasks.projectId, status: tasks.status, source: tasks.source, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]))),
    computeSignals(userId),
  ]);
  const work = open.filter((t) => t.projectId && isOpenWork(t));
  // The Overview's own reading for every project its cards stand for; the same
  // fields from its own tasks for the rest (a subproject, one set aside).
  const signalled = new Map(signals.projects.map((p) => [p.id, p]));
  const ordered = new Map<string, Ordered>();
  const listed = rows.map((p) => {
    const mine = work.filter((t) => t.projectId === p.id);
    const soonest = mine
      .filter((t) => t.dueAt)
      .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())[0];
    const signal = signalled.get(p.id);
    ordered.set(
      p.id,
      signal
        ? { ...orderedOf(signal), position: p.position }
        : {
            name: p.name,
            list: p.kind === "list",
            soonest: soonest?.dueAt ? daysFromToday(soonest.dueAt, timezone, now) : null,
            deadline: p.deadline ? daysFromToday(p.deadline, timezone, now) : null,
            position: p.position,
          }
    );
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.status,
      kind: p.kind,
      group: groupOf(p),
      position: p.position,
      open: mine.length,
      pastDue: mine.filter((t) => isPastDue(t, timezone, now)).length,
      next: soonest ? dueLabel(soonest.dueAt, timezone, now) : "",
    };
  });
  return listed.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || byOrder(ordered.get(a.id)!, ordered.get(b.id)!));
}
