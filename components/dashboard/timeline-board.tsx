"use client";

// Dashboard › Timeline (SEC-A009, Kiron: "make it usable… progress per
// project… filters… like notion, you should be able to move things on it…
// extending start dates, due dates"). One lane per project with its
// progress; tasks as bars from their planned start to their due day, or as a
// single date; one-off events as bars; a red Today line; Week / Month /
// Quarter. Drag a bar's body to move it, its left edge to set the start, its
// right edge to set the due date; drag a single date's small left handle to
// pull out a start; drag a No-date task onto a day. Every move is the same
// operation as saying it: POST /api/timeline/move → update_task or
// update_event (lib/timeline.ts has the geometry and the date math). The
// shell owns all of it; nothing here calls a model.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Lock } from "lucide-react";
import { dueLabel, localDay } from "@/lib/due";
import {
  atDay,
  buildLanes,
  DEFAULT_FILTERS,
  moved,
  PX_PER_DAY,
  shiftedReminders,
  undated,
  windowFor,
  ZOOMS,
  type Filters,
  type Grip,
  type Item,
  type Lane,
  type TlProject,
  type TlTask,
  type Zoom,
} from "@/lib/timeline";
import { openDetail, type EventRow, type TaskRow } from "./shared";

const ROW = 36;
/** The sticky name column: narrower on a phone, where the chart needs the room. */
const NAME_W = { wide: 168, phone: 112 };
const DAY = 86_400_000;
const LONG_PRESS_MS = 350;

// --- per-device settings (zoom, filters, collapsed lanes) ------------------

const STORE_EVENT = "secretary:timeline-settings";
type Settings = { zoom: Zoom; filters: Filters; collapsed: string[] };
const DEFAULT_SETTINGS: Settings = { zoom: "month", filters: DEFAULT_FILTERS, collapsed: [] };
const KEY = "secretary:timeline";

function readSettings(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
/**
 * Open the Timeline on one project (SEC-A007: a tap on Overview's progress
 * strip). The Timeline's project filter is a per-device setting, so this sets
 * it, keeping the device's zoom and other filters.
 */
export function pickTimelineProject(projectId: string) {
  let current: Partial<Settings> = {};
  try {
    const raw = readSettings();
    current = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    /* start from the defaults */
  }
  const next: Settings = {
    zoom: current.zoom && current.zoom in PX_PER_DAY ? current.zoom : DEFAULT_SETTINGS.zoom,
    filters: { ...DEFAULT_FILTERS, ...(current.filters ?? {}), project: projectId },
    collapsed: Array.isArray(current.collapsed) ? current.collapsed : [],
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not remembered; the Timeline opens unfiltered */
  }
  window.dispatchEvent(new Event(STORE_EVENT));
}

function useSettings(): [Settings, (next: Settings) => void] {
  const raw = useSyncExternalStore(
    (cb) => {
      window.addEventListener(STORE_EVENT, cb);
      return () => window.removeEventListener(STORE_EVENT, cb);
    },
    readSettings,
    () => null
  );
  const settings = useMemo<Settings>(() => {
    try {
      const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
      return {
        zoom: parsed.zoom && parsed.zoom in PX_PER_DAY ? parsed.zoom : DEFAULT_SETTINGS.zoom,
        filters: { ...DEFAULT_FILTERS, ...(parsed.filters ?? {}) },
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }, [raw]);
  const save = useCallback((next: Settings) => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* not remembered on this device; still applies now */
    }
    window.dispatchEvent(new Event(STORE_EVENT));
  }, []);
  return [settings, save];
}

/** "Fri, Oct 9", in the user's zone: what a move's toast says. */
const dayLabel = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }).format(new Date(iso));

const PHONE = "(max-width: 639px)";
const isPhone = () => typeof window !== "undefined" && window.matchMedia(PHONE).matches;
function usePhone(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(PHONE);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    isPhone,
    () => false
  );
}

// --- the board ---------------------------------------------------------------

type Toast = { text: string; undo?: () => void; retry?: () => void; tone?: "ok" | "warn" };
type Drag =
  | { kind: "item"; item: Item; grip: Grip; startX: number; days: number; lifted: boolean; pointerId: number }
  | { kind: "tray"; task: TlTask; x: number; y: number; day: number | null; lifted: boolean; pointerId: number };

export function TimelineBoard({
  tasks,
  events,
  projects,
  timezone,
}: {
  tasks: TaskRow[];
  events: EventRow[];
  projects: { id: string; name: string; color: string | null; deadline?: string | null; deadlineKind?: string | null }[];
  timezone: string;
}) {
  const router = useRouter();
  const [settings, save] = useSettings();
  const { zoom, filters } = settings;
  const px = PX_PER_DAY[zoom];
  const nameW = usePhone() ? NAME_W.phone : NAME_W.wide;
  const now = useMemo(() => new Date(), []);
  const today = localDay(now, timezone);

  const tlTasks: TlTask[] = useMemo(
    () =>
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueAt: t.dueAt,
        startAt: t.startAt,
        projectId: t.projectId,
        reminders: t.reminders,
      })),
    [tasks]
  );
  const tlProjects: TlProject[] = useMemo(
    () => projects.map((p) => ({ id: p.id, name: p.name, color: p.color, deadline: p.deadline ?? null, deadlineKind: p.deadlineKind ?? null })),
    [projects]
  );
  const tlEvents = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        projectId: e.projectId,
        recurrence: e.recurrence,
        reminders: e.reminders,
      })),
    [events]
  );

  // Optimistic moves until the server's rows come back.
  // A moved item stays where it was dropped until the server's rows arrive
  // (router.refresh hands new props), so it never snaps back in between.
  type Optimistic = Partial<TlTask> & { startsAt?: string; endsAt?: string | null };
  const [pending, setPending] = useState<{ base: TaskRow[]; map: Map<string, Optimistic> }>({ base: tasks, map: new Map() });
  const live = pending.base === tasks ? pending.map : null;
  const shownTasks = useMemo(() => tlTasks.map((t) => ({ ...t, ...(live?.get(t.id) ?? {}) }) as TlTask), [tlTasks, live]);
  const shownEvents = useMemo(() => tlEvents.map((e) => ({ ...e, ...(live?.get(e.id) ?? {}) })), [tlEvents, live]);

  const lanes = useMemo(
    () => buildLanes(tlProjects, shownTasks, shownEvents, timezone, now, filters),
    [tlProjects, shownTasks, shownEvents, timezone, now, filters]
  );
  // Progress for every project, whatever the project filter: the strip is how to pick one.
  const allLanes = useMemo(
    () => buildLanes(tlProjects, shownTasks, shownEvents, timezone, now, { ...filters, project: "all" }),
    [tlProjects, shownTasks, shownEvents, timezone, now, filters]
  );
  const tray = useMemo(() => undated(shownTasks, filters), [shownTasks, filters]);
  const span = useMemo(() => windowFor(lanes, zoom, timezone, now), [lanes, zoom, timezone, now]);
  const days = span.to - span.from + 1;
  const xOf = (day: number) => (day - span.from) * px;

  const [toast, setToast] = useState<Toast | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once a long press has lifted an item, the finger drags it instead of
  // scrolling the page. touch-action is fixed when the touch starts, so
  // Safari has to be told on every move (a non-passive listener).
  const lifted = useRef(false);
  // A tap opens an item on CLICK, not on pointerup: on touch the browser
  // sends its compatibility click after pointerup, and a dialog opened on
  // pointerup is already under it, so that click landed on the backdrop and
  // shut the dialog ~9 ms later (sec rev). This marks a gesture that dragged
  // or scrolled, whose click must not open anything.
  const gestureMoved = useRef(false);
  const openItem = (kind: "task" | "event", id: string) => {
    if (gestureMoved.current) return;
    openDetail(kind, id);
  };
  useEffect(() => {
    lifted.current = drag?.lifted ?? false;
  }, [drag]);
  useEffect(() => {
    const stop = (e: TouchEvent) => {
      if (lifted.current) e.preventDefault();
    };
    document.addEventListener("touchmove", stop, { passive: false });
    return () => document.removeEventListener("touchmove", stop);
  }, []);


  // --- moves: always the server's tool path -----------------------------------
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/timeline/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown>; undo?: string };
      return { ok: res.ok, result: json.result ?? {}, undo: json.undo ?? null };
    },
    []
  );

  const commit = useCallback(
    async (
      id: string,
      title: string,
      body: Record<string, unknown>,
      optimistic: Optimistic,
      label: string
    ) => {
      setPending((p) => ({ base: tasks, map: new Map(p.base === tasks ? p.map : []).set(id, optimistic) }));
      const { ok, result, undo: ticket } = await send(body);
      if (!ok) {
        setPending((p) => {
          const map = new Map(p.map);
          map.delete(id);
          return { ...p, map };
        });
        setToast({ text: String(result.error ?? "That move didn't save."), tone: "warn" });
        return;
      }
      // Undo is a restore, not another move: the server's sealed ticket puts
      // back exactly what this move changed (lib/timeline-undo.ts).
      const undo = ticket
        ? async () => {
            setToast(null);
            const res = await fetch("/api/timeline/undo", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: ticket }),
            });
            const json = (await res.json().catch(() => ({}))) as { result?: { error?: string; google_problem?: string } };
            if (!res.ok) setToast({ text: json.result?.error ?? "Undo didn't save.", tone: "warn" });
            else if (json.result?.google_problem) setToast({ text: `Put back here; ${json.result.google_problem}`, tone: "warn" });
            router.refresh();
          }
        : undefined;
      const problem = typeof result.google_problem === "string" ? result.google_problem : null;
      setToast(
        problem
          ? {
              text: `Moved "${title}" to ${label}; not on Google yet.`,
              tone: "warn",
              undo,
              retry: async () => {
                const r = await fetch("/api/timeline/google-retry", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id }),
                });
                const json = (await r.json().catch(() => ({}))) as { result?: { google?: string } };
                setToast(
                  r.ok && json.result?.google === "added"
                    ? { text: `"${title}" is on Google now.`, tone: "ok" }
                    : { text: "Google still refused it. The move is saved here.", tone: "warn" }
                );
              },
            }
          : { text: `Moved "${title}" to ${label}`, undo, tone: "ok" }
      );
      router.refresh();
    },
    [router, send, tasks]
  );

  const moveItem = useCallback(
    (item: Item, grip: Grip, dayShift: number) => {
      const change = moved(item, grip, dayShift, timezone);
      if (!change) return;
      if (item.kind === "task") {
        const t = item.task;
        const body: Record<string, unknown> = { kind: "task", id: t.id };
        if (change.due_at) {
          body.due_at = change.due_at;
          if (t.reminders.length) body.reminders = shiftedReminders(t.reminders, dayShift, timezone);
        }
        if (change.start_at !== undefined) body.start_at = change.start_at;
        const optimistic: Partial<TlTask> = {
          ...(change.due_at ? { dueAt: change.due_at } : {}),
          ...(change.start_at !== undefined ? { startAt: change.start_at } : {}),
        };
        void commit(t.id, t.title, body, optimistic, dayLabel(change.due_at ?? change.start_at ?? t.dueAt!, timezone));
        return;
      }
      const e = item.event;
      const body: Record<string, unknown> = { kind: "event", id: e.id };
      if (change.starts_at) body.starts_at = change.starts_at;
      if (change.ends_at) body.ends_at = change.ends_at;
      if (grip === "body" && e.reminders.length) body.reminders = shiftedReminders(e.reminders, dayShift, timezone);
      void commit(
        e.id,
        e.title,
        body,
        { ...(change.starts_at ? { startsAt: change.starts_at } : {}), ...(change.ends_at ? { endsAt: change.ends_at } : {}) },
        dayLabel(change.starts_at ?? change.ends_at ?? e.startsAt, timezone)
      );
    },
    [commit, timezone]
  );

  const dropFromTray = useCallback(
    (task: TlTask, day: number) => {
      const due = atDay(day, timezone);
      void commit(task.id, task.title, { kind: "task", id: task.id, due_at: due }, { dueAt: due }, dayLabel(due, timezone));
    },
    [commit, timezone]
  );

  // --- pointer handling: mouse drags at once; touch after a long press -------
  const dayUnderPointer = (clientX: number, clientY: number): number | null => {
    const el = scroller.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // Only a drop on the board itself gives a date.
    if (clientY < rect.top || clientY > rect.bottom || clientX > rect.right) return null;
    const x = clientX - rect.left + el.scrollLeft - nameW;
    if (x < 0) return null;
    return span.from + Math.floor(x / px);
  };

  const beginItem = (e: React.PointerEvent, item: Item, grip: Grip) => {
    e.stopPropagation();
    gestureMoved.current = false;
    if (isPhone() || (item.kind === "event" && item.locked)) {
      // A phone (T3) and a repeating event (T2): a tap opens it; nothing drags.
      setDrag({ kind: "item", item, grip: "body", startX: e.clientX, days: 0, lifted: false, pointerId: e.pointerId });
      return;
    }
    const start: Drag = { kind: "item", item, grip, startX: e.clientX, days: 0, lifted: e.pointerType === "mouse", pointerId: e.pointerId };
    if (e.pointerType !== "mouse") {
      pressTimer.current = setTimeout(() => setDrag((d) => (d && d.kind === "item" ? { ...d, lifted: true } : d)), LONG_PRESS_MS);
    } else {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDrag(start);
  };
  const beginTray = (e: React.PointerEvent, task: TlTask) => {
    gestureMoved.current = false;
    if (isPhone()) return;
    const start: Drag = { kind: "tray", task, x: e.clientX, y: e.clientY, day: null, lifted: e.pointerType === "mouse", pointerId: e.pointerId };
    if (e.pointerType !== "mouse") {
      pressTimer.current = setTimeout(() => setDrag((d) => (d && d.kind === "tray" ? { ...d, lifted: true } : d)), LONG_PRESS_MS);
    } else {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDrag(start);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.lifted) {
      // Moving before the long press is a scroll: let it go.
      const dx = drag.kind === "item" ? e.clientX - drag.startX : e.clientX - drag.x;
      if (Math.abs(dx) > 8) {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = null;
        gestureMoved.current = true;
        setDrag(null);
      }
      return;
    }
    e.preventDefault();
    if (drag.kind === "tray" || Math.round((e.clientX - drag.startX) / px) !== 0) gestureMoved.current = true;
    if (drag.kind === "item") setDrag({ ...drag, days: Math.round((e.clientX - drag.startX) / px) });
    else setDrag({ ...drag, x: e.clientX, y: e.clientY, day: dayUnderPointer(e.clientX, e.clientY) });
  };
  // The browser took the touch for a scroll: nothing moves, nothing opens.
  const onCancel = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    gestureMoved.current = true;
    setDrag(null);
  };
  const onUp = (e: React.PointerEvent) => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    // pointerup only ends a drag; a tap opens on its click (openItem).
    if (d.kind === "item") {
      if (d.lifted && d.days !== 0) moveItem(d.item, d.grip, d.days);
      return;
    }
    if (d.lifted && d.day !== null) dropFromTray(d.task, d.day);
  };

  // The item as it is drawn: dragged items follow the pointer by whole days.
  const drawn = (item: Item): { from: number; to: number } => {
    if (!drag || drag.kind !== "item" || drag.item.id !== item.id || !drag.lifted || drag.days === 0) return item;
    if (drag.grip === "body") return { from: item.from + drag.days, to: item.to + drag.days };
    if (drag.grip === "start") return { from: Math.min(item.from + drag.days, item.to), to: item.to };
    return { from: item.from, to: Math.max(item.to + drag.days, item.from) };
  };

  // --- render ------------------------------------------------------------------
  const setFilters = (f: Partial<Filters>) => save({ ...settings, filters: { ...filters, ...f } });
  const collapsed = new Set(settings.collapsed);
  const toggleLane = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save({ ...settings, collapsed: [...next] });
  };
  // Open on today (a third in from the left), once per zoom; never again on
  // its own, so a move never scrolls the board out from under the finger.
  const placedFor = useRef<Zoom | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || placedFor.current === zoom) return;
    placedFor.current = zoom;
    // A third into the chart: the sticky name column covers the first nameW px.
    el.scrollLeft = Math.max(0, (today - span.from) * px - (el.clientWidth - nameW) / 3);
  }, [zoom, today, span.from, px, nameW]);
  const scrollToToday = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, xOf(today) - (el.clientWidth - nameW) / 3), behavior: "smooth" });
  };

  const scale = useMemo(() => {
    const ticks: { day: number; label: string; month: string | null }[] = [];
    const step = zoom === "week" ? 1 : zoom === "month" ? 7 : 14;
    for (let d = span.from; d <= span.to; d++) {
      const date = new Date(d * DAY);
      const first = date.getUTCDate() === 1 || d === span.from;
      if ((d - span.from) % step === 0 || first) {
        ticks.push({
          day: d,
          label: String(date.getUTCDate()),
          month: first ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date) : null,
        });
      }
    }
    return ticks;
  }, [span, zoom]);

  const chip = (on: boolean) =>
    `inline-flex min-h-11 flex-none items-center rounded-full border px-3.5 text-xs font-semibold whitespace-nowrap ${
      on ? "border-accent bg-accent/10 text-accent" : "border-edge text-muted hover:text-ink"
    }`;

  return (
    <div className="space-y-3" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
      <ProjectProgressStrip lanes={allLanes} active={filters.project} onPick={(id) => setFilters({ project: filters.project === id ? "all" : id })} />

      {/* One row that scrolls sideways on a phone, so the board stays near the top. */}
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        <div role="tablist" aria-label="Zoom" className="flex flex-none rounded-lg border border-edge bg-surface p-0.5 text-xs">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              role="tab"
              aria-selected={zoom === z.key}
              onClick={() => save({ ...settings, zoom: z.key })}
              className={`min-h-11 rounded-md px-3 font-semibold ${zoom === z.key ? "bg-card text-ink" : "text-muted hover:text-ink"}`}
            >
              {z.label}
            </button>
          ))}
        </div>
        {filters.project !== "all" && (
          <button onClick={() => setFilters({ project: "all" })} className={chip(true)}>
            {allLanes.find((l) => l.id === filters.project)?.name ?? "One project"} ✕
          </button>
        )}
        <button onClick={scrollToToday} className={chip(false)}>
          Today
        </button>
        {(["open", "late", "done", "all"] as const).map((s) => (
          <button key={s} onClick={() => setFilters({ status: s })} className={chip(filters.status === s)} aria-pressed={filters.status === s}>
            {s === "open" ? "Open" : s === "late" ? "Late" : s === "done" ? "Done" : "All"}
          </button>
        ))}
        <button onClick={() => setFilters({ events: !filters.events })} className={chip(filters.events)} aria-pressed={filters.events}>
          Events
        </button>
        <button
          onClick={() => save({ ...settings, collapsed: collapsed.size ? [] : lanes.map((l) => l.id) })}
          className={`${chip(false)} sm:ml-auto`}
        >
          {collapsed.size ? "Expand all" : "Collapse all"}
        </button>
      </div>


      {toast && (
        <div
          role="status"
          className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2 text-sm ${
            toast.tone === "warn" ? "border-warn/40 bg-warn/10" : "border-edge bg-surface"
          }`}
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          {toast.retry && (
            <button onClick={toast.retry} className="min-h-11 px-2 text-xs font-bold text-accent">
              Retry
            </button>
          )}
          {toast.undo && (
            <button onClick={toast.undo} className="min-h-11 px-2 text-xs font-bold text-accent">
              Undo
            </button>
          )}
          <button onClick={() => setToast(null)} aria-label="Close" className="min-h-11 px-2 text-xs text-muted">
            ✕
          </button>
        </div>
      )}

      <div
        ref={scroller}
        data-testid="timeline-board"
        className="relative overflow-x-auto rounded-2xl border border-edge bg-surface"
        style={{ touchAction: drag?.lifted ? "none" : "pan-x pan-y" }}
      >
        <div className="relative" style={{ width: nameW + days * px }}>
          {/* The date scale */}
          <div className="sticky top-0 z-20 flex h-10 border-b border-edge bg-surface">
            <div className="sticky left-0 z-30 flex-none border-r border-edge bg-surface" style={{ width: nameW }} />
            <div className="relative flex-1">
              {scale.map((t) => (
                <div key={t.day} className="absolute top-0 h-full border-l border-edge/50 pl-1 text-[10px] text-faint" style={{ left: xOf(t.day) }}>
                  {t.month && <span className="font-bold text-muted">{t.month} </span>}
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Today */}
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-danger"
            style={{ left: nameW + xOf(today) + px / 2 }}
          />

          {lanes.length === 0 && <p className="px-4 py-6 text-sm text-muted">Nothing on the timeline for these filters.</p>}

          {lanes.map((lane) => (
            <LaneRows
              key={lane.id}
              lane={lane}
              nameW={nameW}
              open={!collapsed.has(lane.id)}
              onToggle={() => toggleLane(lane.id)}
              xOf={xOf}
              px={px}
              drawn={drawn}
              beginItem={beginItem}
              onKeyMove={(item, n) => moveItem(item, "body", n)}
              onOpen={openItem}
              dragging={drag?.kind === "item" && drag.lifted ? drag.item.id : null}
            />
          ))}

          {/* Where a No-date task would land */}
          {drag?.kind === "tray" && drag.lifted && drag.day !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-10 bottom-0 z-10 bg-accent/10"
              style={{ left: nameW + xOf(drag.day), width: px }}
            />
          )}
        </div>
      </div>

      {tray.length > 0 && (
        <div className="rounded-2xl border border-edge bg-surface px-4 py-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">No date ({tray.length})</p>
          <p className="mb-2 text-xs text-faint">Drag one onto a day to give it that date, or tap to set one.</p>
          <div className="flex flex-wrap gap-2">
            {tray.map((t) => (
              <button
                key={t.id}
                type="button"
                onPointerDown={(e) => beginTray(e, t)}
                onClick={() => openItem("task", t.id)}
                className="min-h-11 touch-none rounded-full border border-edge bg-card px-3 text-left text-xs hover:border-faint"
              >
                {t.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The task under the pointer while dragging from the tray */}
      {drag?.kind === "tray" && drag.lifted && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-full border border-accent bg-card px-3 py-2 text-xs shadow-lg"
          style={{ left: drag.x + 8, top: drag.y + 8 }}
        >
          {drag.task.title}
        </div>
      )}
    </div>
  );
}

// --- one project's rows ----------------------------------------------------------

function LaneRows({
  lane,
  nameW,
  open,
  onToggle,
  xOf,
  px,
  drawn,
  beginItem,
  onKeyMove,
  onOpen,
  dragging,
}: {
  lane: Lane;
  nameW: number;
  open: boolean;
  onToggle: () => void;
  xOf: (day: number) => number;
  px: number;
  drawn: (item: Item) => { from: number; to: number };
  beginItem: (e: React.PointerEvent, item: Item, grip: Grip) => void;
  onKeyMove: (item: Item, days: number) => void;
  onOpen: (kind: "task" | "event", id: string) => void;
  dragging: string | null;
}) {
  const pct = lane.total ? Math.round((lane.done / lane.total) * 100) : 0;
  return (
    <div className="border-b border-edge/60">
      <div className="relative flex" style={{ height: ROW + 6 }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="sticky left-0 z-20 flex flex-none items-center gap-1.5 border-r border-edge bg-surface px-2 text-left text-sm font-semibold"
          style={{ width: nameW }}
        >
          <ChevronRight size={13} className={`flex-none transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="h-2 w-2 flex-none rounded-full" style={{ background: lane.color ?? "var(--color-accent)" }} />
          <span className={`min-w-0 truncate ${lane.late ? "text-danger" : ""}`}>{lane.name}</span>
        </button>
        <div className="relative flex-1">
          {lane.from !== null && lane.to !== null && (
            <div
              title={`${lane.done} of ${lane.total} done`}
              className={`absolute top-2 h-5 overflow-hidden rounded-md border ${lane.late ? "border-danger/50" : "border-edge"} bg-surface-2`}
              style={{ left: xOf(lane.from), width: Math.max(px, xOf(lane.to + 1) - xOf(lane.from)) }}
            >
              <div className={`h-full ${lane.late ? "bg-danger/40" : "bg-accent/40"}`} style={{ width: `${pct}%` }} />
            </div>
          )}
          {lane.from !== null && lane.to !== null && (
            // Beside the bar, so a short project still reads in full.
            <span
              className="absolute top-2 flex h-5 items-center whitespace-nowrap text-[10px] font-semibold text-muted"
              style={{ left: Math.max(xOf(lane.from) + px, xOf(lane.to + 1)) + 6 }}
            >
              {lane.done}/{lane.total} done
            </span>
          )}
          {lane.deadline && (
            <div
              title={lane.deadline.committed ? "Committed deadline" : "Deadline"}
              className={`absolute top-1 h-7 w-0.5 ${lane.deadline.committed ? "bg-danger" : "bg-warn"}`}
              style={{ left: xOf(lane.deadline.day) + px - 1 }}
            />
          )}
        </div>
      </div>
      {open &&
        lane.items.map((item) => {
          const at = drawn(item);
          const left = xOf(at.from);
          const width = Math.max(px, xOf(at.to + 1) - left);
          const tone = item.done ? "bg-ok/25 border-ok/40 text-muted line-through" : item.late ? "bg-danger/15 border-danger/50 text-danger" : item.kind === "event" ? "bg-accent/15 border-accent/40" : "bg-card border-edge";
          const locked = item.kind === "event" && item.locked;
          return (
            <div key={item.id} className="relative flex" style={{ height: ROW }}>
              <div
                className="sticky left-0 z-20 flex flex-none items-center truncate border-r border-edge bg-surface px-2 pl-6 text-xs text-muted"
                style={{ width: nameW }}
              >
                <span className="truncate">{item.title}</span>
              </div>
              <div className="relative flex-1">
                {item.bar || item.kind === "event" ? (
                  <div
                    role="button"
                    tabIndex={0}
                    data-item={item.id}
                    aria-label={`${item.title}${locked ? ", repeats (tap to edit)" : ", drag to move"}`}
                    onPointerDown={(e) => beginItem(e, item, "body")}
                    onClick={() => onOpen(item.kind, item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft") onKeyMove(item, -1);
                      if (e.key === "ArrowRight") onKeyMove(item, 1);
                      if (e.key === "Enter") openDetail(item.kind, item.id);
                    }}
                    className={`absolute top-1 flex h-7 items-center overflow-hidden rounded-md border text-[11px] ${tone} ${
                      dragging === item.id ? "shadow-lg ring-2 ring-accent" : ""
                    } ${locked ? "cursor-pointer" : "cursor-grab"} touch-manipulation select-none [-webkit-touch-callout:none]`}
                    style={{ left, width }}
                  >
                    {!locked && (
                      <span
                        aria-hidden
                        onPointerDown={(e) => beginItem(e, item, "start")}
                        className="hidden h-full w-2.5 flex-none cursor-ew-resize bg-ink/10 sm:block"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate px-1.5">
                      {locked && <Lock size={10} className="mr-1 inline" />}
                      {item.title}
                    </span>
                    {!locked && (item.kind === "task" || item.event.endsAt) && (
                      <span
                        aria-hidden
                        onPointerDown={(e) => beginItem(e, item, "end")}
                        className="hidden h-full w-2.5 flex-none cursor-ew-resize bg-ink/10 sm:block"
                      />
                    )}
                  </div>
                ) : (
                  // A single date: a diamond; its small left handle pulls out a start.
                  <div className="absolute top-1 flex h-7 items-center" style={{ left: left + px / 2 - 18 }}>
                    <span
                      aria-hidden
                      onPointerDown={(e) => beginItem(e, item, "start")}
                      className="hidden h-5 w-2.5 cursor-ew-resize rounded-sm bg-ink/10 sm:block"
                    />
                    <span
                      role="button"
                      tabIndex={0}
                      data-item={item.id}
                      aria-label={`${item.title}, drag to move`}
                      onPointerDown={(e) => beginItem(e, item, "body")}
                      onClick={() => onOpen(item.kind, item.id)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowLeft") onKeyMove(item, -1);
                        if (e.key === "ArrowRight") onKeyMove(item, 1);
                        if (e.key === "Enter") openDetail(item.kind, item.id);
                      }}
                      className={`ml-1 h-4 w-4 rotate-45 cursor-grab touch-manipulation select-none border [-webkit-touch-callout:none] ${tone} ${
                        dragging === item.id ? "ring-2 ring-accent" : ""
                      }`}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}

// --- the progress strip ------------------------------------------------------------

/**
 * One line per project: its progress ("3 of 7 done") and whether anything is
 * late. Tapping one shows only that project. Reusable: A007 puts it on Overview.
 */
export function ProjectProgressStrip({
  lanes,
  active,
  onPick,
  compact = false,
  timezone,
}: {
  lanes: Lane[];
  active: string | "all";
  onPick: (id: string) => void;
  /** One swipeable row of chips (Overview, SEC-A007) instead of a grid. */
  compact?: boolean;
  /** With it, each chip also says its next open date (lib/due.ts words). */
  timezone?: string;
}) {
  const shown = lanes.filter((l) => l.total > 0);
  if (shown.length === 0) return null;
  const next = (l: Lane): string | null => {
    if (!timezone) return null;
    const soonest = l.items
      .filter((i): i is Extract<Item, { kind: "task" }> => i.kind === "task" && !i.done)
      .toSorted((a, b) => a.to - b.to)[0];
    return soonest?.task.dueAt ? dueLabel(new Date(soonest.task.dueAt), timezone) : null;
  };
  if (compact) {
    return (
      <div data-testid="progress-strip" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {shown.map((l) => {
          const pct = Math.round((l.done / l.total) * 100);
          const when = next(l);
          return (
            <button
              key={l.id}
              data-project={l.id}
              onClick={() => onPick(l.id)}
              className="flex min-h-11 w-44 flex-none flex-col justify-center gap-1 rounded-xl border border-edge bg-surface px-3 py-2 text-left hover:border-faint"
            >
              <span className="flex w-full items-center gap-1.5">
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: l.color ?? "var(--color-accent)" }} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{l.name}</span>
                <span className={`flex-none text-[11px] ${l.late ? "font-semibold text-danger" : "text-faint"}`}>
                  {l.done}/{l.total}
                </span>
              </span>
              <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-2">
                <span className={`block h-full ${l.late ? "bg-danger" : "bg-ok"}`} style={{ width: `${pct}%` }} />
              </span>
              <span className={`text-[11px] ${l.late ? "text-danger" : "text-faint"}`}>
                {/* The soonest open date says it: "3 days late", "tomorrow", "Fri". */}
                {when ? (l.late ? when : `next ${when}`) : l.late ? "late" : "no dates"}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div
      data-testid="progress-strip"
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible xl:grid-cols-3"
    >
      {shown.map((l) => {
        const pct = Math.round((l.done / l.total) * 100);
        return (
          <button
            key={l.id}
            onClick={() => onPick(l.id)}
            aria-pressed={active === l.id}
            className={`flex min-h-11 w-[78%] flex-none items-center gap-3 rounded-xl border px-3 py-2 text-left sm:w-auto ${
              active === l.id ? "border-accent bg-accent/5" : "border-edge bg-surface hover:border-faint"
            }`}
          >
            <span className="h-2 w-2 flex-none rounded-full" style={{ background: l.color ?? "var(--color-accent)" }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{l.name}</span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2">
                <span className={`block h-full ${l.late ? "bg-danger" : "bg-ok"}`} style={{ width: `${pct}%` }} />
              </span>
            </span>
            <span className={`flex-none text-xs ${l.late ? "font-semibold text-danger" : "text-faint"}`}>
              {l.done} of {l.total} done{l.late ? " · late" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
