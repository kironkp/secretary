// The binding resolver: a validated BindingQuery becomes rows of display
// strings. This is the half of the Workspace that makes it a live view of the
// data rather than a photograph of it.
//
// Three rules hold here without exception:
//   1. Every query is scoped to one userId, in SQL, always.
//   2. The query vocabulary is closed. Nothing here accepts a column name, an
//      operator, or a fragment of SQL from anywhere near the model.
//   3. Fields are formatted for DISPLAY here, once, on the server, in the
//      user's own timezone — never in the widget markup and never in the model.
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, documents, events, projects, tasks } from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import type { BindingQuery, BoundRow } from "./types";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
const DEFAULT_LIMIT = 12;

/** Short, scannable, and in the user's own day. "Fri", "Tue 3", "overdue 2d". */
function formatDue(due: Date | null, tz: string, now: Date): string {
  if (!due) return "";
  const { start } = dayRangeInTz(tz, now);
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(due);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(due);
}

function formatTime(at: Date | null, tz: string): string {
  if (!at) return "";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(at);
}

const STATUS_LABEL: Record<string, string> = {
  inbox: "Inbox",
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

type Stage = { name: string; done: boolean };

function stageLabel(stages: unknown): string {
  if (!Array.isArray(stages) || stages.length === 0) return "";
  const list = stages as Stage[];
  const done = list.filter((s) => s?.done).length;
  const current = list.find((s) => !s?.done);
  return current ? `${current.name} (${done + 1}/${list.length})` : `done (${list.length}/${list.length})`;
}

/**
 * Resolve a project reference the way the rest of the app does: an id, or the
 * user's words for it. Returns null when nothing matches, which the caller
 * turns into an empty result rather than silently showing everything.
 */
async function resolveProjectId(userId: string, ref: string): Promise<string | null> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.userId, userId));
  const needle = ref.trim().toLowerCase();
  const exactId = rows.find((r) => r.id === ref);
  if (exactId) return exactId.id;
  const exact = rows.find((r) => r.name.trim().toLowerCase() === needle);
  if (exact) return exact.id;
  const contains = rows.find(
    (r) => r.name.toLowerCase().includes(needle) || needle.includes(r.name.toLowerCase())
  );
  return contains?.id ?? null;
}

async function resolveTasks(
  userId: string,
  q: BindingQuery,
  tz: string,
  now: Date
): Promise<BoundRow[]> {
  const where = q.where ?? {};
  const conds = [eq(tasks.userId, userId)];

  if (where.open) conds.push(inArray(tasks.status, [...OPEN_STATUSES]));
  if (where.status?.length) conds.push(inArray(tasks.status, where.status));
  if (where.blocked === true) conds.push(eq(tasks.status, "blocked"));
  if (where.stakes === true) conds.push(isNotNull(tasks.stakes));
  if (where.search) conds.push(ilike(tasks.title, `%${where.search}%`));

  if (where.project) {
    const projectId = await resolveProjectId(userId, where.project);
    // An unmatched project shows nothing, rather than quietly showing every task.
    if (!projectId) return [];
    conds.push(eq(tasks.projectId, projectId));
  }

  const { start, end } = dayRangeInTz(tz, now);
  switch (where.due) {
    case "overdue":
      conds.push(and(isNotNull(tasks.dueAt), lt(tasks.dueAt, start))!);
      break;
    case "today":
      conds.push(and(gte(tasks.dueAt, start), lte(tasks.dueAt, end))!);
      break;
    case "week":
      conds.push(and(isNotNull(tasks.dueAt), lte(tasks.dueAt, new Date(end.getTime() + 6 * 86_400_000)))!);
      break;
    case "month":
      conds.push(and(isNotNull(tasks.dueAt), lte(tasks.dueAt, new Date(end.getTime() + 29 * 86_400_000)))!);
      break;
    case "none":
      conds.push(isNull(tasks.dueAt));
      break;
    default:
      break;
  }

  const order =
    q.sort === "created"
      ? [desc(tasks.createdAt)]
      : q.sort === "updated"
        ? [desc(tasks.updatedAt)]
        : q.sort === "priority"
          ? [desc(tasks.priority), asc(tasks.dueAt)]
          : q.sort === "procrastination"
            ? [desc(tasks.procrastinationScore)]
            : q.sort === "title"
              ? [asc(tasks.title)]
              : // Default: soonest first, and undated last rather than first.
                [sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt)];

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueAt: tasks.dueAt,
      notes: tasks.notes,
      stakes: tasks.stakes,
      blockedReason: tasks.blockedReason,
      stages: tasks.stages,
      createdAt: tasks.createdAt,
      projectName: projects.name,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...conds))
    .orderBy(...order)
    .limit(q.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    fields: {
      title: r.title,
      due: formatDue(r.dueAt, tz, now),
      status: STATUS_LABEL[r.status] ?? r.status,
      project: r.projectName ?? "",
      stage: stageLabel(r.stages),
      stakes: r.stakes ?? "",
      blocked: r.blockedReason ?? "",
      notes: r.notes ?? "",
      created: formatDue(r.createdAt, tz, now),
    },
  }));
}

async function resolveEvents(
  userId: string,
  q: BindingQuery,
  tz: string,
  now: Date
): Promise<BoundRow[]> {
  const where = q.where ?? {};
  const conds = [eq(events.userId, userId)];
  if (where.search) conds.push(ilike(events.title, `%${where.search}%`));
  if (where.project) {
    const projectId = await resolveProjectId(userId, where.project);
    if (!projectId) return [];
    conds.push(eq(events.projectId, projectId));
  }
  const { start, end } = dayRangeInTz(tz, now);
  if (where.due === "today") conds.push(and(gte(events.startsAt, start), lte(events.startsAt, end))!);
  else if (where.due === "week")
    conds.push(and(gte(events.startsAt, start), lte(events.startsAt, new Date(end.getTime() + 6 * 86_400_000)))!);
  else conds.push(gte(events.startsAt, start)); // upcoming, not history

  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      location: events.location,
      notes: events.notes,
      projectName: projects.name,
    })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(and(...conds))
    .orderBy(asc(events.startsAt))
    .limit(q.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    fields: {
      title: r.title,
      when: formatTime(r.startsAt, tz),
      location: r.location ?? "",
      project: r.projectName ?? "",
      notes: r.notes ?? "",
    },
  }));
}

async function resolveProjects(userId: string, q: BindingQuery, tz: string, now: Date): Promise<BoundRow[]> {
  const conds = [eq(projects.userId, userId)];
  if (q.where?.search) conds.push(ilike(projects.name, `%${q.where.search}%`));
  if (q.where?.open !== false) conds.push(eq(projects.status, "active"));

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      deadline: projects.deadline,
      open: sql<number>`(
        select count(*) from ${tasks}
        where ${tasks.projectId} = ${projects.id}
          and ${tasks.status} in ('inbox','todo','in_progress','blocked')
      )`,
    })
    .from(projects)
    .where(and(...conds))
    .orderBy(asc(projects.name))
    .limit(q.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    fields: {
      name: r.name,
      status: r.status,
      deadline: formatDue(r.deadline, tz, now),
      open: String(r.open ?? 0),
    },
  }));
}

async function resolveDocuments(userId: string, q: BindingQuery, tz: string, now: Date): Promise<BoundRow[]> {
  const conds = [eq(documents.userId, userId)];
  if (q.where?.search) conds.push(ilike(documents.title, `%${q.where.search}%`));
  if (q.where?.project) {
    const projectId = await resolveProjectId(userId, q.where.project);
    if (!projectId) return [];
    conds.push(eq(documents.projectId, projectId));
  }
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      updatedAt: documents.updatedAt,
      projectName: projects.name,
    })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .where(and(...conds))
    .orderBy(desc(documents.updatedAt))
    .limit(q.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    fields: {
      title: r.title,
      project: r.projectName ?? "",
      updated: formatDue(r.updatedAt, tz, now),
    },
  }));
}

async function resolveCheckins(userId: string, q: BindingQuery, tz: string): Promise<BoundRow[]> {
  const rows = await db
    .select({ id: checkins.id, note: checkins.note, at: checkins.at, taskTitle: tasks.title })
    .from(checkins)
    .leftJoin(tasks, eq(checkins.taskId, tasks.id))
    .where(eq(checkins.userId, userId))
    .orderBy(desc(checkins.at))
    .limit(q.limit ?? DEFAULT_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    fields: {
      note: r.note ?? "",
      task: r.taskTitle ?? "",
      when: formatTime(r.at, tz),
    },
  }));
}

/**
 * Strip the prototype from every row's field map. A template names fields, and
 * a name like `constructor` must resolve to nothing rather than to whatever
 * Object.prototype happens to carry.
 */
function harden(rows: BoundRow[]): BoundRow[] {
  return rows.map((r) => ({ id: r.id, fields: Object.assign(Object.create(null), r.fields) }));
}

/** One query to rows. Unknown sources return nothing rather than throwing. */
export async function resolveBinding(
  userId: string,
  query: BindingQuery,
  tz: string,
  now = new Date()
): Promise<BoundRow[]> {
  switch (query.source) {
    case "tasks":
      return harden(await resolveTasks(userId, query, tz, now));
    case "events":
      return harden(await resolveEvents(userId, query, tz, now));
    case "projects":
      return harden(await resolveProjects(userId, query, tz, now));
    case "documents":
      return harden(await resolveDocuments(userId, query, tz, now));
    case "checkins":
      return harden(await resolveCheckins(userId, query, tz));
    default:
      return [];
  }
}

/** Unused columns are dropped so identical data produces an identical string. */
export function rowsFingerprint(rows: BoundRow[]): string {
  return rows.map((r) => `${r.id}:${Object.values(r.fields).join("")}`).join("");
}

export { or };
