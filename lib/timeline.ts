// The timeline's shape, without a browser (SEC-A009, Kiron: "make it usable…
// showing progress per project… move things on it… extending start dates,
// due dates"). One lane per project with its progress; tasks as bars (start
// to due) or single dates; one-off events as bars; the days are his calendar
// days (lib/due.ts). The shell owns all geometry: nothing here calls a model.
import { localDay } from "@/lib/due";
import { parseInTz, wallTimeInTz } from "@/lib/time";

export type Zoom = "week" | "month" | "quarter";
export const ZOOMS: { key: Zoom; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
];
/** Width of one day, by zoom (T5: Month by default). */
export const PX_PER_DAY: Record<Zoom, number> = { week: 96, month: 30, quarter: 10 };
/** How far the window reaches before and after today, at least. */
const REACH: Record<Zoom, { before: number; after: number }> = {
  week: { before: 7, after: 28 },
  month: { before: 21, after: 90 },
  quarter: { before: 45, after: 270 },
};

export type TlTask = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  startAt: string | null;
  projectId: string | null;
  reminders: string[];
};
export type TlEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  projectId: string | null;
  recurrence: string[];
  reminders: string[];
};
export type TlProject = { id: string; name: string; color: string | null; deadline: string | null; deadlineKind: string | null };

const OPEN = new Set(["inbox", "todo", "in_progress", "blocked"]);
const isOpen = (t: TlTask) => OPEN.has(t.status);

/** Shift an instant by whole days of the user's calendar, keeping its wall-clock time (DST-safe). */
export function shiftDays(iso: string, days: number, tz: string): string {
  const wall = wallTimeInTz(new Date(iso), tz); // "YYYY-MM-DDTHH:MM:SS"
  const [y, m, d] = wall.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return parseInTz(`${date}${wall.slice(10)}`, tz)!.toISOString();
}

/** The instant for a calendar day (days since 1970-01-01) at a wall-clock hour, in the user's zone. */
export function atDay(day: number, tz: string, hour = 17): string {
  const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
  return parseInTz(`${date}T${String(hour).padStart(2, "0")}:00:00`, tz)!.toISOString();
}

export type Item =
  | { kind: "task"; id: string; title: string; from: number; to: number; bar: boolean; late: boolean; done: boolean; task: TlTask }
  | { kind: "event"; id: string; title: string; from: number; to: number; bar: boolean; late: false; done: false; locked: boolean; event: TlEvent };

export type Lane = {
  id: string;
  name: string;
  color: string | null;
  items: Item[];
  /** Tasks done ÷ all the project's tasks (T4), dropped left out. */
  done: number;
  total: number;
  late: boolean;
  /** The project's own extent: earliest start or due to latest due or deadline. */
  from: number | null;
  to: number | null;
  deadline: { day: number; committed: boolean } | null;
};

export type Filters = { project: string | "all"; status: "open" | "late" | "done" | "all"; events: boolean };
export const DEFAULT_FILTERS: Filters = { project: "all", status: "open", events: true };

/** A task's place: a bar from its start to its due day, or a single date. */
export function taskItem(t: TlTask, tz: string, today: number): Item | null {
  if (!t.dueAt) return null;
  const to = localDay(new Date(t.dueAt), tz);
  const start = t.startAt ? localDay(new Date(t.startAt), tz) : null;
  return {
    kind: "task",
    id: t.id,
    title: t.title,
    from: start !== null && start <= to ? start : to,
    to,
    bar: start !== null && start < to,
    late: isOpen(t) && to < today,
    done: t.status === "done",
    task: t,
  };
}

export function eventItem(e: TlEvent, tz: string): Item {
  const from = localDay(new Date(e.startsAt), tz);
  const to = e.endsAt ? Math.max(from, localDay(new Date(e.endsAt), tz)) : from;
  return { kind: "event", id: e.id, title: e.title, from, to, bar: to > from, late: false, done: false, locked: e.recurrence.length > 0, event: e };
}

const keep = (item: Item, f: Filters): boolean => {
  if (item.kind === "event") return f.events && f.status !== "late" && f.status !== "done";
  const t = item.task;
  if (f.status === "open") return isOpen(t);
  if (f.status === "late") return item.late;
  if (f.status === "done") return t.status === "done";
  return t.status !== "dropped";
};

/**
 * One lane per project (and one for tasks in none), late projects first, then
 * by the nearest open due date, then by name. Progress counts every task of
 * the project, whatever the filter shows.
 */
export function buildLanes(
  projects: TlProject[],
  tasks: TlTask[],
  events: TlEvent[],
  tz: string,
  now: Date,
  filters: Filters
): Lane[] {
  const today = localDay(now, tz);
  const lanes = new Map<string, Lane>();
  const laneFor = (id: string | null): Lane => {
    const key = id ?? "none";
    let lane = lanes.get(key);
    if (!lane) {
      const p = projects.find((x) => x.id === id);
      lane = {
        id: key,
        name: p?.name ?? "No project",
        color: p?.color ?? null,
        items: [],
        done: 0,
        total: 0,
        late: false,
        from: null,
        to: null,
        deadline: p?.deadline ? { day: localDay(new Date(p.deadline), tz), committed: p.deadlineKind === "committed" } : null,
      };
      lanes.set(key, lane);
    }
    return lane;
  };
  for (const p of projects) laneFor(p.id);
  for (const t of tasks) {
    if (t.status === "dropped") continue;
    const lane = laneFor(t.projectId);
    lane.total++;
    if (t.status === "done") lane.done++;
    const item = taskItem(t, tz, today);
    if (!item) continue;
    if (item.late) lane.late = true;
    if (isOpen(t)) {
      lane.from = lane.from === null ? item.from : Math.min(lane.from, item.from);
      lane.to = lane.to === null ? item.to : Math.max(lane.to, item.to);
    }
    if (keep(item, filters)) lane.items.push(item);
  }
  for (const e of events) {
    const item = eventItem(e, tz);
    if (keep(item, filters)) laneFor(e.projectId).items.push(item);
  }
  for (const lane of lanes.values()) {
    if (lane.deadline) lane.to = lane.to === null ? lane.deadline.day : Math.max(lane.to, lane.deadline.day);
    lane.items.sort((a, b) => a.from - b.from || a.to - b.to || a.title.localeCompare(b.title));
  }
  const nearest = (l: Lane) => Math.min(...l.items.filter((i) => i.kind === "task" && !i.done).map((i) => i.to), Infinity);
  return [...lanes.values()]
    .filter((l) => (filters.project === "all" ? l.total > 0 || l.items.length > 0 : l.id === filters.project))
    .sort((a, b) => Number(b.late) - Number(a.late) || nearest(a) - nearest(b) || a.name.localeCompare(b.name));
}

/** Open tasks with no date: the No date tray (filtered by project like the lanes). */
export function undated(tasks: TlTask[], filters: Filters): TlTask[] {
  return tasks.filter((t) => isOpen(t) && !t.dueAt && (filters.project === "all" || (t.projectId ?? "none") === filters.project));
}

/** The days the board shows: today's reach at this zoom, widened to every lane's items. */
export function windowFor(lanes: Lane[], zoom: Zoom, tz: string, now: Date): { from: number; to: number } {
  const today = localDay(now, tz);
  let from = today - REACH[zoom].before;
  let to = today + REACH[zoom].after;
  for (const lane of lanes) {
    for (const i of lane.items) {
      from = Math.min(from, i.from - 2);
      to = Math.max(to, i.to + 2);
    }
    if (lane.deadline) to = Math.max(to, lane.deadline.day + 2);
  }
  return { from, to };
}

/** The new dates for a move of `days` days, by what was dragged. Null when nothing would change. */
export type Grip = "body" | "start" | "end";
export function moved(item: Item, grip: Grip, days: number, tz: string): Record<string, string | null> | null {
  if (days === 0) return null;
  if (item.kind === "task") {
    const t = item.task;
    if (!t.dueAt) return null;
    if (grip === "end") {
      // The due date can't come before the start.
      if (t.startAt && localDay(new Date(shiftDays(t.dueAt, days, tz)), tz) < item.from) return null;
      return { due_at: shiftDays(t.dueAt, days, tz), reminders: null };
    }
    if (grip === "start") {
      // A single date grows a start out of its due day; a bar's start moves.
      const base = t.startAt ?? t.dueAt;
      const start = shiftDays(base, days, tz);
      if (localDay(new Date(start), tz) > item.to) return null;
      return { start_at: start };
    }
    return {
      due_at: shiftDays(t.dueAt, days, tz),
      ...(t.startAt ? { start_at: shiftDays(t.startAt, days, tz) } : {}),
      reminders: null,
    };
  }
  const e = item.event;
  if (item.locked) return null;
  if (grip === "start") {
    const start = shiftDays(e.startsAt, days, tz);
    if (e.endsAt && new Date(start) > new Date(e.endsAt)) return null;
    return { starts_at: start };
  }
  if (grip === "end") {
    if (!e.endsAt) return null;
    const end = shiftDays(e.endsAt, days, tz);
    if (new Date(end) < new Date(e.startsAt)) return null;
    return { ends_at: end };
  }
  return {
    starts_at: shiftDays(e.startsAt, days, tz),
    ...(e.endsAt ? { ends_at: shiftDays(e.endsAt, days, tz) } : {}),
    reminders: null,
  };
}

/** Reminders move with what they remind about: every one by the same days. */
export function shiftedReminders(reminders: string[], days: number, tz: string): string[] {
  return reminders.map((r) => shiftDays(r, days, tz));
}
