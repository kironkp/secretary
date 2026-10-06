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
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Lock } from "lucide-react";
import { localDay } from "@/lib/due";
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
const NAME_W = 168;
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

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;

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
  const [pending, setPending] = useState<Map<string, Partial<TlTask> & { startsAt?: string; endsAt?: string | null }>>(new Map());
  const shownTasks = useMemo(() => tlTasks.map((t) => ({ ...t, ...(pending.get(t.id) ?? {}) }) as TlTask), [tlTasks, pending]);
  const shownEvents = useMemo(() => tlEvents.map((e) => ({ ...e, ...(pending.get(e.id) ?? {}) })), [tlEvents, pending]);

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


  // --- moves: always the server's tool path -----------------------------------
  const send = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/timeline/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown> };
      return { ok: res.ok, result: json.result ?? {} };
    },
    []
  );

  const commit = useCallback(
    async (
      id: string,
      title: string,
      body: Record<string, unknown>,
      before: Record<string, unknown>,
      optimistic: Partial<TlTask> & { startsAt?: string; endsAt?: string | null },
      label: string
    ) => {
      setPending((p) => new Map(p).set(id, optimistic));
      const { ok, result } = await send(body);
      if (!ok) {
        setPending((p) => {
          const n = new Map(p);
          n.delete(id);
          return n;
        });
        setToast({ text: String(result.error ?? "That move didn't save."), tone: "warn" });
        return;
      }
      const undo = async () => {
        setToast(null);
        await send(before);
        router.refresh();
      };
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
      setTimeout(
        () =>
          setPending((p) => {
            const n = new Map(p);
            n.delete(id);
            return n;
          }),
        1500
      );
    },
    [router, send]
  );

  const moveItem = useCallback(
    (item: Item, grip: Grip, dayShift: number) => {
      const change = moved(item, grip, dayShift, timezone);
      if (!change) return;
      if (item.kind === "task") {
        const t = item.task;
        const body: Record<string, unknown> = { kind: "task", id: t.id };
        const before: Record<string, unknown> = { kind: "task", id: t.id };
        if (change.due_at) {
          body.due_at = change.due_at;
          before.due_at = t.dueAt;
          if (t.reminders.length) {
            body.reminders = shiftedReminders(t.reminders, dayShift, timezone);
            before.reminders = t.reminders;
          }
        }
        if (change.start_at !== undefined) {
          body.start_at = change.start_at;
          before.start_at = t.startAt;
        }
        const optimistic: Partial<TlTask> = {
          ...(change.due_at ? { dueAt: change.due_at } : {}),
          ...(change.start_at !== undefined ? { startAt: change.start_at } : {}),
        };
        void commit(t.id, t.title, body, before, optimistic, dayLabel(change.due_at ?? change.start_at ?? t.dueAt!, timezone));
        return;
      }
      const e = item.event;
      const body: Record<string, unknown> = { kind: "event", id: e.id };
      const before: Record<string, unknown> = { kind: "event", id: e.id };
      if (change.starts_at) {
        body.starts_at = change.starts_at;
        before.starts_at = e.startsAt;
      }
      if (change.ends_at) {
        body.ends_at = change.ends_at;
        if (e.endsAt) before.ends_at = e.endsAt;
      }
      if (grip === "body" && e.reminders.length) {
        body.reminders = shiftedReminders(e.reminders, dayShift, timezone);
        before.reminders = e.reminders;
      }
      void commit(
        e.id,
        e.title,
        body,
        before,
        { ...(change.starts_at ? { startsAt: change.starts_at } : {}), ...(change.ends_at ? { endsAt: change.ends_at } : {}) },
        dayLabel(change.starts_at ?? change.ends_at ?? e.startsAt, timezone)
      );
    },
    [commit, timezone]
  );

  const dropFromTray = useCallback(
    (task: TlTask, day: number) => {
      const due = atDay(day, timezone);
      // Undo puts it back in the tray: no due date.
      void commit(task.id, task.title, { kind: "task", id: task.id, due_at: due }, { kind: "task", id: task.id, due_at: null }, { dueAt: due }, dayLabel(due, timezone));
    },
    [commit, timezone]
  );

  // --- pointer handling: mouse drags at once; touch after a long press -------
  const dayUnderPointer = (clientX: number): number | null => {
    const el = scroller.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - NAME_W;
    if (x < 0) return null;
    return span.from + Math.floor(x / px);
  };

  const beginItem = (e: React.PointerEvent, item: Item, grip: Grip) => {
    if (isPhone() || (item.kind === "event" && item.locked)) return; // T3, T2: tap edits instead
    e.stopPropagation();
    const start: Drag = { kind: "item", item, grip, startX: e.clientX, days: 0, lifted: e.pointerType === "mouse", pointerId: e.pointerId };
    if (e.pointerType !== "mouse") {
      pressTimer.current = setTimeout(() => setDrag((d) => (d && d.kind === "item" ? { ...d, lifted: true } : d)), LONG_PRESS_MS);
    } else {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDrag(start);
  };
  const beginTray = (e: React.PointerEvent, task: TlTask) => {
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
      if (Math.abs(dx) > 8 && pressTimer.current) {
        clearTimeout(pressTimer.current);
        pressTimer.current = null;
        setDrag(null);
      }
      return;
    }
    e.preventDefault();
    if (drag.kind === "item") setDrag({ ...drag, days: Math.round((e.clientX - drag.startX) / px) });
    else setDrag({ ...drag, x: e.clientX, y: e.clientY, day: dayUnderPointer(e.clientX) });
  };
  const onUp = (e: React.PointerEvent) => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "item") {
      if (d.lifted && d.days !== 0) moveItem(d.item, d.grip, d.days);
      else if (!d.lifted || d.days === 0) openDetail(d.item.kind, d.item.id);
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
  const scrollToToday = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, xOf(today) - el.clientWidth / 3), behavior: "smooth" });
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
    `inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-semibold whitespace-nowrap ${
      on ? "border-accent bg-accent/10 text-accent" : "border-edge text-muted hover:text-ink"
    }`;

  return (
    <div className="space-y-3" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <ProjectProgressStrip lanes={allLanes} active={filters.project} onPick={(id) => setFilters({ project: filters.project === id ? "all" : id })} />

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Zoom" className="flex rounded-lg border border-edge bg-surface p-0.5 text-xs">
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
          className={`${chip(false)} ml-auto`}
        >
          {collapsed.size ? "Expand all" : "Collapse all"}
        </button>
      </div>

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <button onClick={() => setFilters({ project: "all" })} className={chip(filters.project === "all")}>
          All
        </button>
        {allLanes.map((l) => (
          <button key={l.id} onClick={() => setFilters({ project: l.id })} className={chip(filters.project === l.id)}>
            {l.name}
          </button>
        ))}
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
        <div className="relative" style={{ width: NAME_W + days * px }}>
          {/* The date scale */}
          <div className="sticky top-0 z-20 flex h-10 border-b border-edge bg-surface">
            <div className="sticky left-0 z-30 flex-none border-r border-edge bg-surface" style={{ width: NAME_W }} />
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
            style={{ left: NAME_W + xOf(today) + px / 2 }}
          />

          {lanes.length === 0 && <p className="px-4 py-6 text-sm text-muted">Nothing on the timeline for these filters.</p>}

          {lanes.map((lane) => (
            <LaneRows
              key={lane.id}
              lane={lane}
              open={!collapsed.has(lane.id)}
              onToggle={() => toggleLane(lane.id)}
              xOf={xOf}
              px={px}
              drawn={drawn}
              beginItem={beginItem}
              onKeyMove={(item, n) => moveItem(item, "body", n)}
              dragging={drag?.kind === "item" && drag.lifted ? drag.item.id : null}
            />
          ))}

          {/* Where a No-date task would land */}
          {drag?.kind === "tray" && drag.lifted && drag.day !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-10 bottom-0 z-10 bg-accent/10"
              style={{ left: NAME_W + xOf(drag.day), width: px }}
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
                onClick={() => (isPhone() ? openDetail("task", t.id) : undefined)}
                onKeyDown={(e) => e.key === "Enter" && openDetail("task", t.id)}
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
  open,
  onToggle,
  xOf,
  px,
  drawn,
  beginItem,
  onKeyMove,
  dragging,
}: {
  lane: Lane;
  open: boolean;
  onToggle: () => void;
  xOf: (day: number) => number;
  px: number;
  drawn: (item: Item) => { from: number; to: number };
  beginItem: (e: React.PointerEvent, item: Item, grip: Grip) => void;
  onKeyMove: (item: Item, days: number) => void;
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
          style={{ width: NAME_W }}
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
              <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px] font-semibold text-ink">
                {lane.done}/{lane.total} done
              </span>
            </div>
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
                style={{ width: NAME_W }}
              >
                <span className="truncate">{item.title}</span>
              </div>
              <div className="relative flex-1">
                {item.bar || item.kind === "event" ? (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${item.title}${locked ? ", repeats (tap to edit)" : ", drag to move"}`}
                    onPointerDown={(e) => beginItem(e, item, "body")}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft") onKeyMove(item, -1);
                      if (e.key === "ArrowRight") onKeyMove(item, 1);
                      if (e.key === "Enter") openDetail(item.kind, item.id);
                    }}
                    className={`absolute top-1 flex h-7 items-center overflow-hidden rounded-md border text-[11px] ${tone} ${
                      dragging === item.id ? "shadow-lg ring-2 ring-accent" : ""
                    } ${locked ? "cursor-pointer" : "cursor-grab"} touch-manipulation select-none`}
                    style={{ left, width }}
                  >
                    {!locked && (
                      <span
                        aria-hidden
                        onPointerDown={(e) => beginItem(e, item, "start")}
                        className="h-full w-2.5 flex-none cursor-ew-resize bg-ink/10"
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
                        className="h-full w-2.5 flex-none cursor-ew-resize bg-ink/10"
                      />
                    )}
                  </div>
                ) : (
                  // A single date: a diamond; its small left handle pulls out a start.
                  <div className="absolute top-1 flex h-7 items-center" style={{ left: left + px / 2 - 18 }}>
                    <span
                      aria-hidden
                      onPointerDown={(e) => beginItem(e, item, "start")}
                      className="h-5 w-2.5 cursor-ew-resize rounded-sm bg-ink/10"
                    />
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`${item.title}, drag to move`}
                      onPointerDown={(e) => beginItem(e, item, "body")}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowLeft") onKeyMove(item, -1);
                        if (e.key === "ArrowRight") onKeyMove(item, 1);
                        if (e.key === "Enter") openDetail(item.kind, item.id);
                      }}
                      className={`ml-1 h-4 w-4 rotate-45 cursor-grab touch-manipulation border ${tone} ${
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
}: {
  lanes: Lane[];
  active: string | "all";
  onPick: (id: string) => void;
}) {
  const shown = lanes.filter((l) => l.total > 0);
  if (shown.length === 0) return null;
  return (
    <div data-testid="progress-strip" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {shown.map((l) => {
        const pct = Math.round((l.done / l.total) * 100);
        return (
          <button
            key={l.id}
            onClick={() => onPick(l.id)}
            aria-pressed={active === l.id}
            className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2 text-left ${
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
