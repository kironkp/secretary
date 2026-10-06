// The Projects tab (SEC-A006): every project, what is open in it and when
// the next thing is due, counted the way every other screen counts (lib/due.ts:
// open work only, a suggestion still waiting is not counted).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";
import { dueLabel, isOpenWork, isPastDue, OPEN_STATUSES } from "@/lib/due";

export type ProjectListRow = {
  id: string;
  name: string;
  color: string | null;
  status: "active" | "someday" | "archived";
  kind: "project" | "list";
  open: number;
  pastDue: number;
  /** How the soonest open due date reads ("2 days late", "Fri"); empty when nothing is dated. */
  next: string;
};

export async function listProjects(userId: string, timezone: string, now: Date = new Date()): Promise<ProjectListRow[]> {
  const [rows, open] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, color: projects.color, status: projects.status, kind: projects.kind })
      .from(projects)
      .where(eq(projects.userId, userId)),
    db
      .select({ projectId: tasks.projectId, status: tasks.status, source: tasks.source, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]))),
  ]);
  const work = open.filter((t) => t.projectId && isOpenWork(t));
  const rank = { active: 0, someday: 1, archived: 2 } as const;
  return rows
    .map((p) => {
      const mine = work.filter((t) => t.projectId === p.id);
      const soonest = mine
        .filter((t) => t.dueAt)
        .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())[0];
      return {
        ...p,
        open: mine.length,
        pastDue: mine.filter((t) => isPastDue(t, timezone, now)).length,
        next: soonest ? dueLabel(soonest.dueAt, timezone, now) : "",
      };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
