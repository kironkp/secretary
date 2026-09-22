// Gather: one bundle per project — docs/understanding/SPEC.md §3.
//
// The bundle is everything a run may read. Two things decide whether the model
// is called (SPEC §8): the `record_dirty` table says WHICH projects a tick
// looks at, and the bundle's hash against records.inputs_hash says WHETHER
// anything it would read has changed. The local calendar date is part of the
// hash, so the morning run re-runs every active project even when no row
// moved, because a day passing changes what "today" and "tomorrow" mean.
//
// Every query filters on userId in SQL, the contract lib/db/queries.ts states.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  documents,
  events,
  expectations,
  memories,
  messages,
  projects,
  records,
  tasks,
} from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import { resolveBinding } from "@/lib/workspace/bindings";
import { getBoard } from "@/lib/workspace/store";
import type { BindingSource } from "@/lib/workspace/types";
import { extractTerms, termMatcher } from "./terms";
import type {
  Bundle,
  BundleDocument,
  BundleEvent,
  BundleExpectation,
  BundleMemory,
  BundleMessage,
  BundleTask,
  BundleWidget,
} from "./types";

/** SPEC §3: over the bound the newest win and the bundle records the drop. */
export const BOUNDS = {
  tasksOpen: 60,
  tasksDone: 60,
  memories: 60,
  messages: 80,
  events: 20,
  documents: 20,
} as const;

const DAY_MS = 86_400_000;
const DONE_DAYS = 60;
const MESSAGE_DAYS = 30;
const EVENT_DAYS = 14;
const DONE_STATUSES = ["done", "dropped"] as const;

/** A memory row as gather reads it: everything the bundle and the tag match need. */
export type MemoryRow = {
  id: string;
  fact: string;
  tags: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** A user message row in the 30-day window, before term matching. */
export type MessageRow = { id: string; content: string; createdAt: Date; mode: string };

export type GatherOptions = {
  now?: Date;
  timezone: string;
  /**
   * Widgets already resolved and attributed by widgetsByOwner, keyed by
   * project id. gatherAll passes this so a sweep resolves the board once, not
   * once per project.
   */
  widgets?: Map<string, BundleWidget[]>;
  /**
   * Memories and messages have no project link, so every project's bundle is
   * filtered from the same two reads. gatherAll does those reads once and
   * hands them down; a single gatherProject reads them itself.
   */
  memories?: MemoryRow[];
  messages?: MessageRow[];
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** YYYY-MM-DD for `date` as the user's wall calendar reads it. */
export function localDateInTz(tz: string, date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The next calendar day, computed on the date itself so DST cannot skip or repeat one. */
function nextLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

// --------------------------------------------------------------------------
// Widgets: which project writes which lede
// --------------------------------------------------------------------------

/**
 * The project a resolved row belongs to, by name, from the display fields the
 * binding resolver already formats. A row with no project (a checkin, an
 * unfiled task) belongs to nobody and counts for no one.
 */
function rowProjectName(source: BindingSource, fields: Record<string, string>): string {
  if (source === "projects") return fields.name ?? "";
  return fields.project ?? "";
}

function rowTitle(source: BindingSource, fields: Record<string, string>): string {
  if (source === "projects") return fields.name ?? "";
  if (source === "checkins") return fields.task || fields.note || "";
  return fields.title ?? "";
}

/**
 * Resolve the user's default board once and hand each bound widget to the
 * project whose rows are the plurality of it (ties: the lexicographically
 * smallest project name). A widget's lede is written by that project's run,
 * so the run must see the widget's row titles — the only names a lede may use.
 * Widgets with no rows, or none attributable to a project, belong to nobody.
 *
 * The result is keyed by project ID. Rows only carry the project's name (the
 * display field the binding resolver formats), and `projects` has no unique
 * (user_id, name) constraint, so a name is turned back into an id here, once,
 * by exact match against the user's own projects — the same string the
 * resolver's join produced. A name two projects share is ambiguous; the widget
 * then belongs to nobody rather than to both, because two runs writing one
 * lede would be a contradiction the loop itself created.
 */
export async function widgetsByOwner(
  userId: string,
  timezone: string,
  now: Date
): Promise<Map<string, BundleWidget[]>> {
  const { board } = await getBoard(userId);
  const owned = new Map<string, BundleWidget[]>();
  if (!board.widgets.some((w) => w.query)) return owned;

  const idsByName = new Map<string, string[]>();
  const named = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.userId, userId));
  for (const p of named) {
    idsByName.set(p.name, [...(idsByName.get(p.name) ?? []), p.id]);
  }

  for (const w of board.widgets) {
    if (!w.query) continue;
    const rows = await resolveBinding(userId, w.query, timezone, now);
    if (rows.length === 0) continue;

    const counts = new Map<string, number>();
    for (const r of rows) {
      const name = rowProjectName(w.query.source, r.fields);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    let winner: string | null = null;
    let best = 0;
    for (const [name, n] of counts) {
      if (n > best || (n === best && winner !== null && name < winner)) {
        winner = name;
        best = n;
      }
    }
    if (winner === null) continue;
    const candidates = idsByName.get(winner) ?? [];
    if (candidates.length !== 1) continue;

    const source = w.query.source;
    const widget: BundleWidget = {
      id: w.id,
      title: w.title,
      rows: rows.map((r) => ({ id: r.id, title: rowTitle(source, r.fields) })),
    };
    const list = owned.get(candidates[0]) ?? [];
    list.push(widget);
    owned.set(candidates[0], list);
  }
  return owned;
}

// --------------------------------------------------------------------------
// The two reads every project shares
// --------------------------------------------------------------------------

/** All of a user's memories, newest first. Term matching happens per project. */
export async function loadMemories(userId: string): Promise<MemoryRow[]> {
  return db
    .select({
      id: memories.id,
      fact: memories.fact,
      tags: memories.tags,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.updatedAt));
}

/** The user's own turns from the last 30 days, newest first. Never the assistant's. */
export async function loadMessages(userId: string, now: Date): Promise<MessageRow[]> {
  return db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
      mode: messages.mode,
    })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.role, "user"),
        gte(messages.createdAt, new Date(now.getTime() - MESSAGE_DAYS * DAY_MS))
      )
    )
    .orderBy(desc(messages.createdAt));
}

// --------------------------------------------------------------------------
// One project
// --------------------------------------------------------------------------

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  stages: BundleTask["stages"];
  blockedReason: string | null;
  stakes: string | null;
  source: string;
  recurrence: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  total: string | number;
};

const taskColumns = {
  id: tasks.id,
  title: tasks.title,
  notes: tasks.notes,
  status: tasks.status,
  stages: tasks.stages,
  blockedReason: tasks.blockedReason,
  stakes: tasks.stakes,
  source: tasks.source,
  recurrence: tasks.recurrence,
  dueAt: tasks.dueAt,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  // The window count rides along so a bounded query still knows how many
  // rows it left behind, without a second round trip.
  total: sql<string>`count(*) over()`,
};

const toTask = (r: TaskRow): BundleTask => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  status: r.status,
  stages: Array.isArray(r.stages) ? r.stages : [],
  blockedReason: r.blockedReason,
  stakes: r.stakes,
  source: r.source,
  recurrence: r.recurrence,
  dueAt: iso(r.dueAt),
  completedAt: iso(r.completedAt),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const totalOf = (rows: { total: string | number }[]): number =>
  rows.length ? Number(rows[0].total) : 0;

/**
 * Build the bundle for one project. Returns null when the project is not this
 * user's, so a caller can never gather across users by guessing an id.
 */
export async function gatherProject(
  userId: string,
  projectId: string,
  opts: GatherOptions
): Promise<Bundle | null> {
  const now = opts.now ?? new Date();
  const tz = opts.timezone;

  const [project] = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return null;

  const [prev] = await db
    .select({ body: records.body })
    .from(records)
    .where(and(eq(records.userId, userId), eq(records.projectId, project.id)))
    .limit(1);
  const previousRecord = prev?.body ?? null;

  const dropped: Bundle["dropped"] = [];
  const noteDrop = (field: string, total: number, kept: number) => {
    if (total > kept) dropped.push({ field, count: total - kept });
  };

  // --- tasks --------------------------------------------------------------
  const openRows = await db
    .select(taskColumns)
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.projectId, project.id),
        notInArray(tasks.status, [...DONE_STATUSES])
      )
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(BOUNDS.tasksOpen);
  noteDrop("tasksOpen", totalOf(openRows), openRows.length);

  // SPEC §3: finished in the last 60 days by completed_at OR updated_at. A
  // row whose completion is inside the window but whose last edit is older
  // (a fixture, a direct write) is still the evidence that its open twin is
  // stale, so neither column alone decides.
  const doneCutoff = new Date(now.getTime() - DONE_DAYS * DAY_MS);
  const finishedAt = sql`coalesce(${tasks.completedAt}, ${tasks.updatedAt})`;
  const doneRows = await db
    .select(taskColumns)
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.projectId, project.id),
        inArray(tasks.status, [...DONE_STATUSES]),
        or(gte(tasks.completedAt, doneCutoff), gte(tasks.updatedAt, doneCutoff))
      )
    )
    .orderBy(desc(finishedAt))
    .limit(BOUNDS.tasksDone);
  noteDrop("tasksDone", totalOf(doneRows), doneRows.length);

  const tasksOpen = openRows.map(toTask);
  const tasksDone = doneRows.map(toTask);
  const allTasks = [...tasksOpen, ...tasksDone];

  // --- terms, then the inputs with no project link -------------------------
  const terms = extractTerms({
    projectName: project.name,
    previousRecord,
    titles: allTasks.map((t) => t.title),
    notes: allTasks.map((t) => t.notes ?? "").filter(Boolean),
  });
  const mentions = termMatcher(terms);
  const projectTag = project.name.toLowerCase();
  const projectIdTag = `project:${project.id}`.toLowerCase();

  const memoryRows = opts.memories ?? (await loadMemories(userId));
  const memoryHits = memoryRows.filter((m) => {
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const tagged = tags.some((t) => {
      const lower = String(t).toLowerCase();
      return lower === projectTag || lower === projectIdTag;
    });
    return tagged || mentions(m.fact);
  });
  noteDrop("memories", memoryHits.length, Math.min(memoryHits.length, BOUNDS.memories));
  const memoryList: BundleMemory[] = memoryHits.slice(0, BOUNDS.memories).map((m) => ({
    id: m.id,
    fact: m.fact,
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));

  const messageRows = opts.messages ?? (await loadMessages(userId, now));
  const messageHits = messageRows.filter((m) => mentions(m.content));
  noteDrop("messages", messageHits.length, Math.min(messageHits.length, BOUNDS.messages));
  const messageList: BundleMessage[] = messageHits.slice(0, BOUNDS.messages).map((m) => ({
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    mode: m.mode,
  }));

  // --- events: from the start of the user's today, 14 days out -------------
  // Ordered soonest first rather than newest first: over the bound, the
  // meetings closest to now are the ones "tomorrow" is about.
  const { start: todayStart } = dayRangeInTz(tz, now);
  const eventRows = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      notes: events.notes,
      projectId: events.projectId,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        gte(events.startsAt, todayStart),
        lte(events.startsAt, new Date(now.getTime() + EVENT_DAYS * DAY_MS))
      )
    )
    .orderBy(asc(events.startsAt));
  const eventHits = eventRows.filter((e) => e.projectId === project.id || mentions(e.title));
  noteDrop("events", eventHits.length, Math.min(eventHits.length, BOUNDS.events));
  const eventList: BundleEvent[] = eventHits.slice(0, BOUNDS.events).map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: iso(e.endsAt),
    location: e.location,
    notes: e.notes,
    projectId: e.projectId,
  }));

  // --- documents ---------------------------------------------------------
  const documentRows = await db
    .select({
      id: documents.id,
      title: documents.title,
      updatedAt: documents.updatedAt,
      total: sql<string>`count(*) over()`,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.projectId, project.id)))
    .orderBy(desc(documents.updatedAt))
    .limit(BOUNDS.documents);
  noteDrop("documents", totalOf(documentRows), documentRows.length);
  const documentList: BundleDocument[] = documentRows.map((d) => ({
    id: d.id,
    title: d.title,
    updatedAt: d.updatedAt.toISOString(),
  }));

  // --- expectations: open or missed, on this project's tasks ---------------
  const expectationRows = await db
    .select({
      id: expectations.id,
      taskId: expectations.taskId,
      commitment: expectations.commitment,
      expectedUpdateBy: expectations.expectedUpdateBy,
      onMiss: expectations.onMiss,
      status: expectations.status,
    })
    .from(expectations)
    .innerJoin(tasks, eq(expectations.taskId, tasks.id))
    .where(
      and(
        eq(expectations.userId, userId),
        eq(tasks.projectId, project.id),
        inArray(expectations.status, ["open", "missed"])
      )
    )
    .orderBy(asc(expectations.expectedUpdateBy));
  const expectationList: BundleExpectation[] = expectationRows.map((e) => ({
    id: e.id,
    taskId: e.taskId,
    commitment: e.commitment,
    expectedUpdateBy: e.expectedUpdateBy.toISOString(),
    onMiss: e.onMiss,
    status: e.status,
  }));

  // --- widgets -----------------------------------------------------------
  const owned = opts.widgets ?? (await widgetsByOwner(userId, tz, now));
  const widgets = owned.get(project.id) ?? [];

  const localDate = localDateInTz(tz, now);
  return {
    userId,
    project,
    clock: {
      nowIso: now.toISOString(),
      timezone: tz,
      localDate,
      tomorrowLocalDate: nextLocalDate(localDate),
    },
    tasksOpen,
    tasksDone,
    memories: memoryList,
    messages: messageList,
    expectations: expectationList,
    events: eventList,
    documents: documentList,
    previousRecord,
    widgets,
    dropped,
    terms,
  };
}

// --------------------------------------------------------------------------
// The hash
// --------------------------------------------------------------------------

const byId = <T extends { id: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * sha256 of the bundle's identity: which rows are in it, when they last
 * changed, and the local date. Never the text, never the previous record, and
 * never the terms — so a re-run on unchanged data is a hash compare and
 * nothing else, and the order rows came back in cannot cause a run.
 */
export function hashBundle(bundle: Bundle): string {
  const canonical = {
    localDate: bundle.clock.localDate,
    tasks: byId([...bundle.tasksOpen, ...bundle.tasksDone]).map((t) => [
      t.id,
      t.status,
      t.updatedAt,
      t.dueAt,
    ]),
    memories: byId(bundle.memories).map((m) => [m.id, m.updatedAt]),
    messages: byId(bundle.messages).map((m) => m.id),
    events: byId(bundle.events).map((e) => [e.id, e.startsAt]),
    documents: byId(bundle.documents).map((d) => [d.id, d.updatedAt]),
    expectations: byId(bundle.expectations).map((e) => [e.id, e.status]),
    widgets: byId(bundle.widgets).map((w) => [w.id, w.rows.map((r) => r.id).sort()]),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// --------------------------------------------------------------------------
// Every active project
// --------------------------------------------------------------------------

/**
 * One bundle per active project. The board, the memories and the 30-day
 * messages are read once here and shared: they are per user, not per project,
 * and N projects must not mean N scans of each.
 */
export async function gatherAll(userId: string, opts: GatherOptions): Promise<Bundle[]> {
  const now = opts.now ?? new Date();
  const shared: GatherOptions = {
    now,
    timezone: opts.timezone,
    widgets: opts.widgets ?? (await widgetsByOwner(userId, opts.timezone, now)),
    memories: opts.memories ?? (await loadMemories(userId)),
    messages: opts.messages ?? (await loadMessages(userId, now)),
  };
  const active = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.status, "active")))
    .orderBy(asc(projects.name));

  const bundles: Bundle[] = [];
  for (const p of active) {
    const bundle = await gatherProject(userId, p.id, shared);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}
