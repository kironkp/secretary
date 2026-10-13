"use client";

// The fixed component palette the adaptive layout engine arranges (A-4),
// restyled to match planning-documents/secretary-target.html: square-dot
// urgency pills, compact stat tiles, a "Next up" hero, reference-style project
// cards, a 5-week pressure timeline, and the grouped Open-loops table.
import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlarmClock,
  CalendarClock,
  CalendarX,
  Check,
  Flame,
  FolderKanban,
  ListTodo,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { ChevronRight, FileText } from "lucide-react";
import { useHideUntilNew } from "./hide-until-new";
import {
  isMomentumTap,
  CheckButton,
  ProvenanceLink,
  ReminderChip,
  RepeatChip,
  StageDots,
  dueText,
  fmtDue,
  isOverdue,
  openDetail,
  type DocRow,
  type EventRow,
  type TaskRow,
} from "./shared";

const OPEN = new Set(["inbox", "todo", "in_progress", "blocked"]);
const DAY = 86400000;

/** "Upcoming" for event visibility in task-centric zones: the next 14 days. */
export const UPCOMING_EVENT_DAYS = 14;

function upcomingEventsOf(events: EventRow[], days = UPCOMING_EVENT_DAYS): EventRow[] {
  const now = Date.now();
  const horizon = now + days * DAY;
  return events
    .filter((e) => {
      const t = new Date(e.startsAt).getTime();
      return t >= now - 60 * 60000 && t <= horizon; // still show for an hour after start
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

type Tone = "danger" | "warn" | "ok" | "neut";

/** Reference-style status pill: square dot + short label. */
export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const box: Record<Tone, string> = {
    danger: "border-danger/40 bg-danger/10 text-danger",
    warn: "border-warn/40 bg-warn/10 text-warn",
    ok: "border-ok/40 bg-ok/10 text-ok",
    neut: "border-edge bg-surface-2 text-muted",
  };
  const dot: Record<Tone, string> = {
    danger: "bg-danger",
    warn: "bg-warn",
    ok: "bg-ok",
    neut: "bg-faint",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${box[tone]}`}
    >
      <span className={`h-[7px] w-[7px] flex-none rounded-[2px] ${dot[tone]}`} />
      {children}
    </span>
  );
}

function daysUntil(iso: string, now: number): number {
  return Math.ceil((new Date(iso).getTime() - now) / DAY);
}


/** Deadline pressure → tone (colour is pressure, never project identity). */
function pressureTone(days: number | null): Tone {
  if (days === null) return "neut";
  if (days <= 3) return "danger";
  if (days <= 14) return "warn";
  return "neut";
}

/**
 * A date's colour where the date itself is shown (SPEC §7: dates, never
 * countdowns): red only when it is actually late, amber within three days.
 * The 5-week chart keeps its own pressure scale.
 */
function dateTone(days: number | null): Tone {
  if (days === null) return "neut";
  if (days < 0) return "danger";
  if (days <= 3) return "warn";
  return "neut";
}

function shortDate(d: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

function sourceLabel(t: TaskRow): string {
  const when = shortDate(new Date(t.updatedAt));
  return `${t.source} · ${when}`;
}

// ---------------------------------------------------------------------------
// overdue callout
// ---------------------------------------------------------------------------

/**
 * "N past due" (SEC-A006): a small chip, never every title joined by dots.
 * A tap opens the list, each row opening its task; Hide keeps it away until
 * something new goes past due (hide-until-new.ts, Kiron's pick). The count
 * is the one Today shows: open, due on a day before today (lib/due.ts).
 */
export function PastDueChip({ tasks }: { tasks: TaskRow[] }) {
  const pastDue = useMemo(
    () => tasks.filter(isOverdue).sort((a, b) => (a.dueDays ?? 0) - (b.dueDays ?? 0)),
    [tasks]
  );
  const ids = useMemo(() => pastDue.map((t) => t.id), [pastDue]);
  const { ready, hidden, hide } = useHideUntilNew("secretary:past-due-hidden", ids);
  const [open, setOpen] = useState(false);
  if (pastDue.length === 0 || !ready || hidden) return null;
  return (
    <div data-testid="past-due-chip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-4 text-sm font-semibold text-danger"
      >
        <TriangleAlert size={15} strokeWidth={2} />
        {pastDue.length} past due
        <ChevronRight size={14} strokeWidth={2.5} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="animate-rise-in mt-2 rounded-xl border border-edge bg-surface px-4 py-2">
          <ul className="divide-y divide-edge/50">
            {pastDue.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => openDetail("task", t.id)}
                  className="flex min-h-11 w-full flex-wrap items-center gap-2 py-1.5 text-left text-sm hover:text-accent"
                >
                  <span className="font-medium">{t.title}</span>
                  {t.projectName && <span className="text-xs text-faint">{t.projectName}</span>}
                  <span className="ml-auto text-xs font-semibold text-danger">{dueText(t)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={hide}
            className="mt-1 inline-flex min-h-11 items-center text-xs font-semibold text-muted hover:text-ink"
          >
            Hide until something new is past due
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// stat tiles — compact single row, accent only where it means something
// ---------------------------------------------------------------------------

/** What a row opens (SEC-A006: nothing on the board that looks tappable is a dead end). */
type Opens = { kind: "task" | "event"; id: string } | { kind: "project"; id: string } | null;
type StatDetail = { key: string; title: string; detail?: string; tone?: Tone; pill?: string; opens: Opens };

function computeStats(tasks: TaskRow[], events: EventRow[]) {
  const now = Date.now();
  const open = tasks.filter((t) => OPEN.has(t.status));
  const overdueTasks = tasks.filter(isOverdue);
  const undatedTasks = open.filter((t) => !t.dueAt);

  const projectMap = new Map<string, { id: string | null; count: number; soonest: TaskRow | null }>();
  for (const t of open) {
    if (!t.projectName) continue;
    const p = projectMap.get(t.projectName) ?? { id: t.projectId, count: 0, soonest: null };
    p.count++;
    if (t.dueAt && (!p.soonest || t.dueAt < p.soonest.dueAt!)) p.soonest = t;
    projectMap.set(t.projectName, p);
  }

  const upcoming = [
    ...events
      .filter((e) => new Date(e.startsAt).getTime() >= now)
      .map((e) => ({ title: e.title, at: e.startsAt, days: e.startDays, label: e.startLabel, kind: "event" as const, id: e.id })),
    ...open
      .filter((t) => t.dueAt && new Date(t.dueAt).getTime() >= now)
      .map((t) => ({ title: t.title, at: t.dueAt!, days: t.dueDays!, label: t.dueLabel, kind: "task" as const, id: t.id })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const taskRow = (t: TaskRow, pill: string, tone: Tone): StatDetail => ({
    key: t.id,
    title: t.title,
    detail: t.projectName ?? undefined,
    pill,
    tone,
    opens: { kind: "task", id: t.id },
  });

  const details: Record<string, StatDetail[]> = {
    projects: [...projectMap.entries()].map(([name, p]) => ({
      key: name,
      title: name,
      detail: `${p.count} open`,
      pill: p.soonest ? dueText(p.soonest) : "undated",
      tone: p.soonest ? pressureTone(p.soonest.dueDays) : "warn",
      opens: p.id ? { kind: "project", id: p.id } : null,
    })),
    next: upcoming.slice(0, 6).map((u, i) => ({
      key: `${u.title}-${i}`,
      title: u.title,
      detail: u.kind,
      pill: u.label,
      tone: pressureTone(u.days),
      opens: { kind: u.kind, id: u.id },
    })),
    overdue: overdueTasks.map((t) => taskRow(t, dueText(t), "danger")),
    open: open
      .slice()
      .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
      .map((t) => taskRow(t, t.dueAt ? dueText(t) : "no date", t.dueAt ? pressureTone(t.dueDays) : "warn")),
    undated: undatedTasks.map((t) => taskRow(t, "no date", "warn")),
  };

  const nextLabel = upcoming.length ? upcoming[0].label : null;
  return {
    open: open.length,
    overdue: overdueTasks.length,
    undated: undatedTasks.length,
    projects: projectMap.size,
    nextLabel,
    details,
  };
}

export function StatTiles({ tasks, events }: { tasks: TaskRow[]; events: EventRow[] }) {
  const s = useMemo(() => computeStats(tasks, events), [tasks, events]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const tiles: {
    id: string;
    value: string;
    unit?: string;
    label: string;
    Icon: typeof ListTodo;
    tone?: string;
  }[] = [
    { id: "projects", value: String(s.projects), label: "active projects", Icon: FolderKanban },
    {
      id: "next",
      // The date of it, as every screen says dates (SPEC §7): "tomorrow",
      // "Fri", "Oct 9"; never "1d".
      value: s.nextLabel ?? "—",
      label: "your next commitment",
      Icon: CalendarClock,
    },
    {
      id: "overdue",
      value: String(s.overdue),
      label: "past due",
      Icon: TriangleAlert,
      tone: s.overdue > 0 ? "text-danger" : undefined,
    },
    { id: "open", value: String(s.open), label: "open next-actions", Icon: ListTodo },
    {
      id: "undated",
      value: String(s.undated),
      label: "items with no date on them",
      Icon: CalendarX,
      tone: s.undated > 0 ? "text-warn" : undefined,
    },
  ];

  const detail = expanded ? (s.details[expanded] ?? []) : [];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => {
          const active = expanded === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setExpanded(active ? null : t.id)}
              aria-expanded={active}
              className={`rounded-xl border px-4 py-3.5 text-left transition-colors ${
                active
                  ? "border-accent bg-surface ring-2 ring-accent/20"
                  : "border-edge bg-surface hover:border-faint"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`text-[26px] font-bold leading-none tracking-tight ${t.tone ?? ""}`}>
                  {t.value}
                  {t.unit && <span className="text-base font-semibold text-faint">{t.unit}</span>}
                </p>
                <t.Icon size={15} strokeWidth={1.75} className="mt-0.5 flex-none text-faint" />
              </div>
              <p className="mt-1.5 text-xs leading-tight text-faint">{t.label}</p>
            </button>
          );
        })}
      </div>

      {expanded && (
        <div className="animate-rise-in mt-2 rounded-xl border border-edge bg-surface px-4 py-3">
          {detail.length === 0 ? (
            <p className="py-1 text-sm text-faint">
              {expanded === "overdue"
                ? "Nothing past due — clean slate."
                : expanded === "undated"
                  ? "Everything has a date. As it should."
                  : "Nothing here yet."}
            </p>
          ) : (
            <ul className="divide-y divide-edge/50">
              {detail.slice(0, 8).map((d) => {
                const body = (
                  <>
                    <span className="font-medium">{d.title}</span>
                    {d.detail && <span className="text-xs text-faint">{d.detail}</span>}
                    {d.pill && (
                      <span className="ml-auto">
                        <Pill tone={d.tone ?? "neut"}>{d.pill}</Pill>
                      </span>
                    )}
                  </>
                );
                // Every row opens what it names, a 44 px target (SEC-A006).
                const row = "flex min-h-11 w-full flex-wrap items-center gap-2 py-1.5 text-left text-sm";
                const opens = d.opens;
                return (
                  <li key={d.key}>
                    {opens?.kind === "project" ? (
                      <Link href={`/projects/${opens.id}`} className={`${row} hover:text-accent`}>
                        {body}
                      </Link>
                    ) : opens ? (
                      <button type="button" onClick={() => openDetail(opens.kind, opens.id)} className={`${row} hover:text-accent`}>
                        {body}
                      </button>
                    ) : (
                      <div className={row}>{body}</div>
                    )}
                  </li>
                );
              })}
              {detail.length > 8 && (
                <li className="py-1.5 text-xs text-faint">+ {detail.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// next-up hero — the one thing that matters before anything else does
// ---------------------------------------------------------------------------

export function findNextUp(
  tasks: TaskRow[],
  events: EventRow[]
): {
  kind: "task" | "event";
  id: string;
  at: Date;
  title: string;
  meta: string;
  notes: string | null;
  reminders: string[];
  days: number;
  label: string;
} | null {
  const now = Date.now();
  const candidates: {
    kind: "task" | "event";
    id: string;
    at: Date;
    title: string;
    meta: string;
    notes: string | null;
    reminders: string[];
  }[] = [
    ...events
      .filter((e) => new Date(e.startsAt).getTime() >= now)
      .map((e) => ({
        kind: "event" as const,
        id: e.id,
        at: new Date(e.startsAt),
        title: e.title,
        meta: [
          new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
            new Date(e.startsAt)
          ),
          e.location,
          e.projectName,
        ]
          .filter(Boolean)
          .join(" · "),
        notes: e.notes,
        reminders: e.reminders,
      })),
    ...tasks
      .filter((t) => OPEN.has(t.status) && t.dueAt && new Date(t.dueAt).getTime() >= now)
      .map((t) => ({
        kind: "task" as const,
        id: t.id,
        at: new Date(t.dueAt!),
        title: t.title,
        meta: [t.projectName, t.postponedCount ? `pushed ${t.postponedCount}×` : "due"]
          .filter(Boolean)
          .join(" · "),
        notes: t.notes,
        reminders: t.reminders,
      })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = candidates[0];
  if (!first) return null;
  const task = first.kind === "task" ? tasks.find((t) => t.id === first.id) : undefined;
  const event = first.kind === "event" ? events.find((e) => e.id === first.id) : undefined;
  const days = task ? (task.dueDays ?? 0) : (event?.startDays ?? 0);
  const label = task ? task.dueLabel : (event?.startLabel ?? "");
  return { ...first, days, label };
}

export function NextUpHero({ tasks, events }: { tasks: TaskRow[]; events: EventRow[] }) {
  const next = useMemo(() => findNextUp(tasks, events), [tasks, events]);
  if (!next) return null;
  const days = next.days;
  return (
    <div
      onClick={() => openDetail(next.kind, next.id)}
      className="flex cursor-pointer flex-wrap items-center gap-5 rounded-2xl border border-edge bg-gradient-to-b from-surface-2 to-surface px-6 py-5 transition-colors hover:border-faint"
    >
      <div className="min-w-[76px]">
        <p className="text-4xl font-bold leading-none tracking-tight">{next.at.getDate()}</p>
        <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
          {new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(next.at)} ·{" "}
          {new Intl.DateTimeFormat("en-US", { month: "short" }).format(next.at)}
        </p>
      </div>
      <div className="w-px self-stretch bg-edge" aria-hidden />
      <div className="min-w-[220px] flex-1">
        <p className="text-lg font-semibold tracking-tight">{next.title}</p>
        <p className="mt-1 text-sm text-muted">
          {next.notes ? `${next.meta} · ${next.notes}` : next.meta}
        </p>
        {next.reminders.length > 0 && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <AlarmClock size={12} strokeWidth={2} className="text-warn" />
            {[...next.reminders]
              .sort()
              .map((r) =>
                new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
                  new Date(r)
                )
              )
              .join(" · ")}
          </p>
        )}
      </div>
      <Pill tone={dateTone(days)}>{next.label}</Pill>
    </div>
  );
}

// ---------------------------------------------------------------------------
// five-week pressure timeline
// ---------------------------------------------------------------------------

const HORIZON_DAYS = 35;

type TlRow = {
  name: string;
  days: number | null;
  label: string;
  /** meetings on this project's row — subtle markers, pressure stays the star */
  eventMarks: { pct: number; label: string }[];
};

/**
 * The timeline's clock, quantized to the top of the hour.
 *
 * Positions here are a fraction of a 35-day horizon measured from "now". With
 * a live Date.now() the server renders at T and the client hydrates a second
 * later at T+1s, so every marker lands at a microscopically different percent —
 * 40.474362% vs 40.4743322420635% — and React reports a hydration mismatch on
 * every dashboard load. It is invisible to the eye and fatal to hydration.
 *
 * A day is the resolution this view actually expresses — one day is 2.9% of the
 * horizon, and nothing here can render finer. Quantizing to it makes every
 * position identical on both sides of hydration for the whole day rather than
 * merely most of the time, which an hourly tick would still get wrong for any
 * load straddling the boundary. It also stabilises the useMemo.
 */
const TIMELINE_TICK_MS = 24 * 60 * 60 * 1000;
function timelineNow(): number {
  return Math.floor(Date.now() / TIMELINE_TICK_MS) * TIMELINE_TICK_MS;
}

export function timelineRows(tasks: TaskRow[], events: EventRow[] = []): TlRow[] {
  const now = timelineNow();
  const byProject = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (!OPEN.has(t.status)) continue;
    const key = t.projectName ?? "Unfiled";
    byProject.set(key, [...(byProject.get(key) ?? []), t]);
  }
  const marksFor = (name: string) =>
    events
      .filter((e) => (e.projectName ?? "Unfiled") === name)
      .map((e) => ({ at: new Date(e.startsAt).getTime(), title: e.title, startsAt: e.startsAt }))
      .filter((e) => e.at >= now && e.at <= now + HORIZON_DAYS * DAY)
      .map((e) => ({
        pct: Math.min(100, Math.max(1, ((e.at - now) / (HORIZON_DAYS * DAY)) * 100)),
        label: `${e.title} · ${fmtDue(e.startsAt)}`,
      }));

  const rows: TlRow[] = [];
  for (const [name, rowTasks] of byProject) {
    const dated = rowTasks
      .filter((t) => t.dueAt)
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
    if (dated.length === 0) {
      rows.push({
        name: `${name} ×${rowTasks.length}`,
        days: null,
        label: "no dates",
        eventMarks: marksFor(name),
      });
    } else {
      const t = dated[0];
      const days = daysUntil(t.dueAt!, now);
      rows.push({ name, days, label: `${t.title} · ${fmtDue(t.dueAt)}`, eventMarks: marksFor(name) });
    }
  }
  // projects that only have events still deserve a row
  for (const e of events) {
    const key = e.projectName ?? "Unfiled";
    if (!byProject.has(key) && !rows.some((r) => r.name === key)) {
      const marks = marksFor(key);
      if (marks.length) rows.push({ name: key, days: null, label: "events only", eventMarks: marks });
    }
  }
  return rows
    .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))
    .slice(0, 6);
}

function weekTicks() {
  // Same quantized clock as timelineRows — these labels are rendered on both
  // sides of hydration too.
  const now = timelineNow();
  return [7, 14, 21, 28].map((d) => ({
    pct: (d / HORIZON_DAYS) * 100,
    label: shortDate(new Date(now + d * DAY)),
  }));
}

export function FiveWeekTimeline({ tasks, events }: { tasks: TaskRow[]; events: EventRow[] }) {
  const rows = useMemo(() => timelineRows(tasks, events), [tasks, events]);
  const ticks = useMemo(() => weekTicks(), []);
  if (rows.length === 0) return null;

  const barColor: Record<Tone, string> = {
    danger: "bg-danger",
    warn: "bg-warn",
    ok: "bg-ok",
    neut: "bg-faint",
  };

  return (
    <div className="rounded-2xl border border-edge bg-surface p-5">
      <div className="flex">
        <div className="w-28 flex-none sm:w-32">
          {rows.map((r) => (
            <div key={r.name} className="flex h-9 items-center">
              <span className="truncate text-xs text-muted">{r.name}</span>
            </div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* week gridlines + today line */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute bottom-0 top-0 w-px bg-accent/70" style={{ left: 0 }} />
            {ticks.map((t) => (
              <div
                key={t.pct}
                className="absolute bottom-0 top-0 w-px bg-edge"
                style={{ left: `${t.pct}%` }}
              />
            ))}
          </div>
          {rows.map((r) => {
            const tone = pressureTone(r.days);
            const pct =
              r.days === null
                ? null
                : Math.min(100, Math.max(2.5, (r.days / HORIZON_DAYS) * 100));
            return (
              <div key={r.name} className="relative h-9" title={r.label}>
                {pct === null ? (
                  <div className="absolute left-0 right-0 top-1/2 border-t-2 border-dashed border-edge" />
                ) : (
                  <>
                    <div
                      className={`absolute left-0 top-1/2 h-[7px] -translate-y-1/2 rounded-full opacity-80 ${barColor[tone]}`}
                      style={{ width: `${pct}%` }}
                    />
                    <div
                      className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface ${barColor[tone]}`}
                      style={{ left: `${pct}%` }}
                    />
                  </>
                )}
                {r.eventMarks.map((m, i) => (
                  <div
                    key={i}
                    title={m.label}
                    className="absolute top-1/2 z-[1] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-surface bg-accent"
                    style={{ left: `${m.pct}%` }}
                  />
                ))}
              </div>
            );
          })}
          {/* axis */}
          <div className="relative mt-1 h-5 border-t border-edge">
            <span className="absolute -translate-x-0 text-[10px] font-semibold text-accent" style={{ left: 0 }}>
              Today
            </span>
            {ticks.map((t) => (
              <span
                key={t.pct}
                className="absolute -translate-x-1/2 text-[10px] text-faint"
                style={{ left: `${t.pct}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-edge pt-3 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-2.5 rounded-[3px] bg-danger" /> imminent — under a week
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-2.5 rounded-[3px] bg-warn" /> tight — under two weeks
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-2.5 rounded-[3px] bg-faint" /> runway
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-0.5 w-2.5 border-t-2 border-dashed border-faint" /> undated
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2 w-2 rotate-45 bg-accent" /> meeting/event
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// documents — living documents, where work actually happens
// ---------------------------------------------------------------------------

function editedAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function DocumentsZone({ docs, fresh }: { docs: DocRow[]; fresh?: Set<string> }) {
  if (docs.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {docs.map((d) => (
        <Link
          key={d.id}
          href={`/documents/${d.id}`}
          className={`flex flex-col gap-2 rounded-2xl border border-edge bg-surface p-5 transition-colors hover:border-faint ${
            fresh?.has(d.id) ? "animate-task-in" : ""
          }`}
        >
          <div className="flex items-start gap-2.5">
            <FileText size={16} strokeWidth={1.75} className="mt-0.5 flex-none text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold tracking-tight">{d.title}</p>
              <p className="mt-0.5 text-xs text-faint">
                {d.projectName ?? "unfiled"} · {d.sectionCount} section
                {d.sectionCount === 1 ? "" : "s"} · edited {editedAgo(d.updatedAt)}
              </p>
            </div>
          </div>
          {d.headings.length > 0 && (
            <p className="truncate text-xs text-muted">{d.headings.join(" · ")}</p>
          )}
          {!d.hasContent && (
            <p className="text-xs text-warn">Outline only — no content yet</p>
          )}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// coming up — the next reminders (tasks + events) in the next 24h
// ---------------------------------------------------------------------------

type UpcomingReminder = { at: Date; title: string; kind: "task" | "event"; id: string };

/** Next-48h reminder horizon for the coming-up strip. */
const COMING_UP_HOURS = 48;

export function upcomingReminders(tasks: TaskRow[], events: EventRow[]): UpcomingReminder[] {
  const now = Date.now();
  const horizon = now + COMING_UP_HOURS * 60 * 60 * 1000;
  const out: UpcomingReminder[] = [];
  for (const t of tasks) {
    if (!OPEN.has(t.status)) continue;
    for (const iso of t.reminders) {
      const at = new Date(iso);
      if (at.getTime() >= now && at.getTime() <= horizon)
        out.push({ at, title: t.title, kind: "task", id: t.id });
    }
  }
  for (const e of events) {
    for (const iso of e.reminders) {
      const at = new Date(iso);
      if (at.getTime() >= now && at.getTime() <= horizon)
        out.push({ at, title: e.title, kind: "event", id: e.id });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, 8);
}

export function ComingUpStrip({ tasks, events }: { tasks: TaskRow[]; events: EventRow[] }) {
  const upcoming = useMemo(() => upcomingReminders(tasks, events), [tasks, events]);
  if (upcoming.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {upcoming.map((r, i) => (
        <button
          key={`${r.id}-${i}`}
          onClick={() => openDetail(r.kind, r.id)}
          className="flex min-w-[150px] flex-none items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-faint"
        >
          <AlarmClock size={15} strokeWidth={1.75} className="flex-none text-warn" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold tabular-nums leading-tight">
              {new Intl.DateTimeFormat("en-US", {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              }).format(r.at)}
            </span>
            <span className="block max-w-[180px] truncate text-xs text-muted">{r.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// calendar strip (kept for AI-generated layouts)
// ---------------------------------------------------------------------------

function buildStripDays(events: EventRow[]) {
  const now = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i + 1);
    return {
      date: d,
      events: events.filter((e) => {
        const t = new Date(e.startsAt);
        return t >= d && t < next;
      }),
    };
  });
}

export function CalendarStrip({ events }: { events: EventRow[] }) {
  const days = useMemo(() => buildStripDays(events), [events]);
  if (days.every((d) => d.events.length === 0)) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {days.map(({ date, events: dayEvents }, i) => (
        <div
          key={date.toISOString()}
          className={`min-w-[120px] flex-1 rounded-xl border px-3 py-2.5 ${
            i === 0 ? "border-accent/40 bg-surface" : "border-edge bg-surface"
          }`}
        >
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-faint">
            {i === 0
              ? "Today"
              : new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric" }).format(date)}
          </p>
          {dayEvents.length === 0 ? (
            <p className="text-xs text-faint">—</p>
          ) : (
            dayEvents.map((e) => (
              <p
                key={e.id}
                onClick={() => openDetail("event", e.id)}
                className="mb-0.5 cursor-pointer truncate rounded text-xs hover:bg-surface-2/60"
              >
                <span className="text-muted">
                  {new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(e.startsAt))}
                </span>{" "}
                {e.title}
              </p>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// procrastination + suggested zones
// ---------------------------------------------------------------------------

export function ProcrastinationZone({ tasks }: { tasks: TaskRow[] }) {
  const offenders = tasks
    .filter((t) => OPEN.has(t.status) && t.procrastinationScore >= 3)
    .sort((a, b) => b.procrastinationScore - a.procrastinationScore)
    .slice(0, 5);
  if (offenders.length === 0) return null;
  return (
    <div className="rounded-2xl border border-edge bg-surface px-5 py-4">
      <p className="mb-2.5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-warn">
        <Flame size={13} strokeWidth={2} /> Procrastinating
      </p>
      {offenders.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => openDetail("task", t.id)}
          className="flex min-h-11 w-full flex-wrap items-center gap-2 text-left text-sm hover:text-accent"
        >
          {t.title}
          <span className="text-xs text-faint">
            {[
              t.postponedCount ? `pushed ${t.postponedCount}×` : null,
              isOverdue(t) ? dueText(t) : null,
            ]
              .filter(Boolean)
              .join(" · ") || "stalling"}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Suggestions, one at a time (SEC-A006): the title in large text, why under
 * it, Add and Not now ("Not now" is the old dismiss). Hide suggestions folds
 * the area to "See suggestions (N)" until a new one arrives
 * (hide-until-new.ts).
 */
export function SuggestedZone({ suggestions }: { suggestions: TaskRow[] }) {
  const router = useRouter();
  const [acted, setActed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const visible = useMemo(() => suggestions.filter((s) => !acted.has(s.id)), [suggestions, acted]);
  const ids = useMemo(() => visible.map((s) => s.id), [visible]);
  const { ready, hidden, hide, show } = useHideUntilNew("secretary:suggestions-hidden", ids);

  const act = async (id: string, status: "todo" | "dropped") => {
    if (isMomentumTap()) return; // scroll-stop tap must never accept/dismiss
    setBusy(id);
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(null);
    if (res.ok) {
      setActed((h) => new Set(h).add(id));
      router.refresh();
    }
  };

  if (visible.length === 0 || !ready) return null;
  if (hidden) {
    return (
      <button
        type="button"
        onClick={show}
        data-testid="see-suggestions"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-edge bg-surface px-4 text-sm font-semibold text-muted hover:text-ink"
      >
        <Sparkles size={14} strokeWidth={2} className="text-ok" /> See suggestions ({visible.length})
      </button>
    );
  }
  const s = visible[0];
  return (
    <div data-testid="suggestion" className="rounded-2xl border border-edge bg-surface px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.08em] text-ok">
          <Sparkles size={13} strokeWidth={2} /> Suggestion
        </p>
        {visible.length > 1 && <span className="text-xs text-faint">1 of {visible.length}</span>}
        <button
          type="button"
          onClick={hide}
          className="ml-auto inline-flex min-h-11 items-center text-xs font-semibold text-muted hover:text-ink"
        >
          Hide suggestions
        </button>
      </div>
      <p className="text-xl font-semibold leading-snug">{s.title}</p>
      {s.notes && <p className="mt-1 text-sm text-muted">{s.notes.replace(/^Suggested: /, "")}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy === s.id}
          onClick={() => act(s.id, "todo")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-ok px-5 text-sm font-bold text-bg disabled:opacity-50"
        >
          <Check size={15} strokeWidth={2.5} /> Add
        </button>
        <button
          type="button"
          disabled={busy === s.id}
          onClick={() => act(s.id, "dropped")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-edge px-5 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
        >
          <X size={15} strokeWidth={2.5} /> Not now
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// project cards — the reference's unit of organization
// ---------------------------------------------------------------------------

type ProjectCard = {
  id: string | null; // null for the synthetic "Unfiled" card
  name: string;
  color: string | null;
  open: TaskRow[];
  doneRecent: TaskRow[];
  doneCount: number;
  earliestDays: number | null;
  /** How that earliest date reads (lib/due.ts), never a countdown. */
  earliestLabel: string | null;
  latestSource: TaskRow | null;
  nextEvent: EventRow | null;
};

export function buildProjects(tasks: TaskRow[], events: EventRow[] = []): ProjectCard[] {
  const now = Date.now();
  const map = new Map<string, ProjectCard>();
  const ensure = (key: string, color: string | null, id: string | null = null) => {
    let p = map.get(key);
    if (!p) {
      p = {
        id,
        name: key,
        color,
        open: [],
        doneRecent: [],
        doneCount: 0,
        earliestDays: null,
        earliestLabel: null,
        latestSource: null,
        nextEvent: null,
      };
      map.set(key, p);
    }
    return p;
  };
  for (const t of tasks) {
    const p = ensure(t.projectName ?? "Unfiled", t.projectColor, t.projectId);
    if (!p.id && t.projectId) p.id = t.projectId;
    if (OPEN.has(t.status)) {
      p.open.push(t);
      if (t.dueDays !== null) {
        const d = t.dueDays;
        if (p.earliestDays === null || d < p.earliestDays) {
          p.earliestDays = d;
          p.earliestLabel = t.dueLabel;
        }
      }
    } else if (t.status === "done") {
      p.doneCount++;
      if (now - new Date(t.updatedAt).getTime() < 7 * DAY) p.doneRecent.push(t);
    }
    if (
      t.conversationId &&
      (!p.latestSource || t.updatedAt.localeCompare(p.latestSource.updatedAt) > 0)
    ) {
      p.latestSource = t;
    }
  }
  // events are peers: they set the project's next date and appear on its card
  for (const e of upcomingEventsOf(events)) {
    const p = ensure(e.projectName ?? "Unfiled", null, e.projectId);
    if (!p.id && e.projectId) p.id = e.projectId;
    if (!p.nextEvent || e.startsAt < p.nextEvent.startsAt) p.nextEvent = e;
    const d = e.startDays;
    if (p.earliestDays === null || d < p.earliestDays) {
      p.earliestDays = d;
      p.earliestLabel = e.startLabel;
    }
  }
  return [...map.values()]
    .filter((p) => p.open.length > 0 || p.doneRecent.length > 0 || p.nextEvent !== null)
    .sort((a, b) => (a.earliestDays ?? Infinity) - (b.earliestDays ?? Infinity));
}

export function ProjectGrid({
  tasks,
  events,
  crossing,
  onDone,
  single = false,
  unfolded = false,
}: {
  tasks: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  /** One project's card, the full width of its cell: the plan's grid lays the cards out (SEC-A007). */
  single?: boolean;
  /** Every open item listed, not the first three (a plan's inline_loops, SEC-A007). */
  unfolded?: boolean;
}) {
  const projects = useMemo(() => buildProjects(tasks, events), [tasks, events]);
  // "+ N more" is a real control: tap to unfold the full task list in place.
  const [expanded, setExpanded] = useState<Set<string>>(() => (unfolded ? new Set(buildProjects(tasks, events).map((p) => p.name)) : new Set()));
  if (projects.length === 0) return null;

  return (
    <div className={single ? "grid gap-3" : "grid gap-3 md:grid-cols-2"}>
      {projects.map((p) => {
        const total = p.open.length + p.doneCount;
        const donePct = total === 0 ? 0 : Math.round((p.doneCount / total) * 100);
        const tone = pressureTone(p.earliestDays);
        const fill: Record<Tone, string> = {
          danger: "bg-danger",
          warn: "bg-warn",
          ok: "bg-ok",
          neut: "bg-accent",
        };
        const sorted = [...p.open].sort((a, b) =>
          (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999")
        );
        return (
          <div
            key={p.name}
            className="flex flex-col gap-3.5 rounded-2xl border border-edge bg-surface p-5"
          >
            {(() => {
              // The whole header is the way in (SEC-A006): name, "N open" and
              // the date pill all open the project page, one target of at
              // least 44 px. The chevron is ALWAYS visible (no hover on
              // touch, and an invisible affordance is a dead end), and the
              // link carries no hover-gated content: iOS Safari spends the
              // first tap on hover when it does, eating the navigation.
              const header = (
                <>
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
                      <span
                        className="h-2 w-2 flex-none rounded-full"
                        style={{ background: p.color ?? "var(--color-accent)" }}
                      />
                      {p.name}
                      {p.id && <ChevronRight size={14} strokeWidth={2} className="flex-none opacity-60" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      {p.open.length} open{p.doneCount ? ` · ${p.doneCount} done` : ""}
                    </span>
                  </div>
                  {p.earliestDays !== null ? (
                    <Pill tone={dateTone(p.earliestDays)}>{p.earliestLabel}</Pill>
                  ) : (
                    <Pill tone="warn">undated</Pill>
                  )}
                </>
              );
              return p.id ? (
                <Link
                  href={`/projects/${p.id}`}
                  aria-label={`${p.name}, ${p.open.length} open`}
                  className="-mx-2 -my-1.5 flex min-h-11 items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-2/40 hover:text-accent"
                >
                  {header}
                </Link>
              ) : (
                <div className="flex items-start gap-2.5">{header}</div>
              );
            })()}

            <div>
              <div className="mb-1.5 flex justify-between text-xs text-faint">
                <span>
                  {p.doneCount} of {total} done
                </span>
                <span className="tabular-nums">{donePct}%</span>
              </div>
              <div className="flex h-[7px] overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${fill[tone]}`}
                  style={{ width: `${Math.max(donePct, 3)}%` }}
                />
              </div>
            </div>

            {p.nextEvent && (
              <button
                onClick={() => openDetail("event", p.nextEvent!.id)}
                className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-left text-sm transition-colors hover:border-accent/60"
              >
                <CalendarClock size={14} strokeWidth={1.75} className="flex-none text-accent" />
                <span className="min-w-0 flex-1 truncate">{p.nextEvent.title}</span>
                <span className="flex-none text-xs text-muted">
                  {new Intl.DateTimeFormat("en-US", {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(p.nextEvent.startsAt))}
                </span>
                <ReminderChip reminders={p.nextEvent.reminders} />
              </button>
            )}
            <ul className="flex flex-col gap-2">
              {p.doneRecent.slice(0, 1).map((t) => (
                <li key={t.id} className="flex items-start gap-2.5 text-sm">
                  <span className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md bg-ok text-bg">
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <span className="text-faint line-through">{t.title}</span>
                </li>
              ))}
              {(expanded.has(p.name) ? sorted : sorted.slice(0, 3)).map((t) => (
                <li
                  key={t.id}
                  onClick={() => openDetail("task", t.id)}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md text-sm transition-colors hover:bg-surface-2/40"
                >
                  <span className="mt-0.5">
                    <CheckButton t={t} onDone={onDone} />
                  </span>
                  <span className={`cross-off min-w-0 ${crossing.has(t.id) ? "crossed text-faint" : ""}`}>
                    {t.title}
                    {t.stages.length > 0 && (
                      <span className="ml-1.5 inline-block align-middle">
                        <StageDots stages={t.stages} />
                      </span>
                    )}
                    {t.recurrence && (
                      <span className="ml-1.5 inline-block align-middle">
                        <RepeatChip recurrence={t.recurrence} />
                      </span>
                    )}
                    {t.reminders.length > 0 && (
                      <span className="ml-1.5 inline-block align-middle">
                        <ReminderChip reminders={t.reminders} />
                      </span>
                    )}
                    {t.dueAt && (
                      <span className={`ml-1.5 text-xs ${isOverdue(t) ? "text-danger" : "text-faint"}`}>
                        {dueText(t)}
                      </span>
                    )}
                    {t.source === "inferred" && (
                      <span className="ml-1.5 rounded border border-edge px-1 py-px text-[9px] uppercase tracking-wide text-faint">
                        inferred
                      </span>
                    )}
                  </span>
                </li>
              ))}
              {sorted.length > 3 && (
                <li>
                  <button
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.name)) next.delete(p.name);
                        else next.add(p.name);
                        return next;
                      })
                    }
                    className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-semibold text-muted transition-colors hover:text-ink"
                  >
                    <ChevronRight
                      size={12}
                      strokeWidth={2.5}
                      className={`transition-transform ${expanded.has(p.name) ? "rotate-90" : ""}`}
                    />
                    {expanded.has(p.name) ? "Show fewer" : `Show all ${sorted.length}`}
                  </button>
                </li>
              )}
            </ul>

            {p.latestSource && (
              <div className="mt-auto flex items-center gap-2 border-t border-edge pt-3 text-[11px] text-faint">
                <span className="rounded border border-edge bg-surface-2 px-1.5 py-px">
                  {sourceLabel(p.latestSource)}
                </span>
                <ProvenanceLink t={p.latestSource} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// open loops — grouped by project, dated first, undated at the bottom
// ---------------------------------------------------------------------------

export type LoopItem =
  | { kind: "task"; date: string | null; task: TaskRow }
  | { kind: "event"; date: string; event: EventRow };

/** Open loops = open tasks + upcoming events (next 14 days), grouped by
 *  project, date-sorted together; undated tasks sink to the group's bottom. */
export function buildLoopGroups(tasks: TaskRow[], events: EventRow[] = []) {
  const now = Date.now();
  const map = new Map<string, { items: LoopItem[]; done: TaskRow[]; projectId: string | null }>();
  const ensure = (key: string) => {
    const g = map.get(key) ?? { items: [], done: [], projectId: null as string | null };
    map.set(key, g);
    return g;
  };
  for (const t of tasks) {
    const g = ensure(t.projectName ?? "Unfiled");
    if (t.projectId) g.projectId = t.projectId;
    if (OPEN.has(t.status)) g.items.push({ kind: "task", date: t.dueAt, task: t });
    else if (t.status === "done" && now - new Date(t.updatedAt).getTime() < 7 * DAY) g.done.push(t);
  }
  for (const e of upcomingEventsOf(events)) {
    const g = ensure(e.projectName ?? "Unfiled");
    if (e.projectId) g.projectId = e.projectId;
    g.items.push({ kind: "event", date: e.startsAt, event: e });
  }
  return [...map.entries()]
    .filter(([, g]) => g.items.length + g.done.length > 0)
    .map(([name, g]) => ({
      name,
      projectId: g.projectId,
      items: g.items.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999")),
      done: g.done,
      earliest: g.items.map((i) => i.date).find(Boolean) ?? null,
      earliestLabel:
        g.items
          .filter((i) => i.date)
          .map((i) => (i.kind === "task" ? i.task.dueLabel : i.event.startLabel))[0] ?? null,
      openCount: g.items.filter((i) => i.kind === "task").length,
      eventCount: g.items.filter((i) => i.kind === "event").length,
    }))
    .sort((a, b) => (a.earliest ?? "9999").localeCompare(b.earliest ?? "9999"));
}

export function OpenLoopsTable({
  tasks,
  events,
  crossing,
  onDone,
  fresh,
}: {
  tasks: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  fresh?: Set<string>;
}) {
  const groups = useMemo(() => buildLoopGroups(tasks, events), [tasks, events]);

  if (groups.length === 0) {
    return (
      <p className="rounded-2xl border border-edge bg-surface px-4 py-8 text-center text-sm text-muted">
        Nothing yet — mention a task in chat or voice and it lands here.
      </p>
    );
  }

  const whenPill = (t: TaskRow) => {
    if (!t.dueAt) return <Pill tone="warn">no date</Pill>;
    return <Pill tone={pressureTone(t.dueDays)}>{dueText(t)}</Pill>;
  };

  const eventWhenPill = (e: EventRow) => {
    return (
      <Pill tone={pressureTone(e.startDays)}>
        {new Intl.DateTimeFormat("en-US", {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(e.startsAt))}
      </Pill>
    );
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-edge bg-surface">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          {/* Plain words (SEC-A007, Kiron: "I don't understand all the whats"). */}
          <tr className="bg-surface-2 text-left text-xs text-muted">
            <th className="w-[55%] px-4 py-2.5 font-semibold">Task</th>
            <th className="w-[25%] px-4 py-2.5 font-semibold">Due</th>
            <th className="px-4 py-2.5 font-semibold">Added</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.name}>
              <tr className="border-y border-edge bg-surface-2/60">
                <td colSpan={3} className="px-4 py-2">
                  {g.projectId ? (
                    <Link
                      href={`/projects/${g.projectId}`}
                      className="text-[13px] font-bold tracking-tight hover:text-accent hover:underline"
                    >
                      {g.name}
                    </Link>
                  ) : (
                    <span className="text-[13px] font-bold tracking-tight">{g.name}</span>
                  )}
                  <span className="ml-2.5 text-xs text-faint">
                    {g.openCount} open
                    {g.eventCount
                      ? ` · ${g.eventCount} event${g.eventCount > 1 ? "s" : ""}`
                      : ""}
                    {g.earliestLabel
                      ? ` · next ${g.earliestLabel}`
                      : g.openCount
                        ? " · no dates"
                        : ""}
                  </span>
                </td>
              </tr>
              {g.items.map((item) =>
                item.kind === "event" ? (
                  <tr
                    key={`e-${item.event.id}`}
                    onClick={() => openDetail("event", item.event.id)}
                    className={`cursor-pointer border-b border-edge/50 transition-colors last:border-0 hover:bg-surface-2/40 ${
                      fresh?.has(item.event.id) ? "animate-task-in" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-5 w-5 flex-none items-center justify-center text-accent">
                          <CalendarClock size={14} strokeWidth={1.75} />
                        </span>
                        <span>{item.event.title}</span>
                        {item.event.notes && (
                          <span className="max-w-[220px] truncate text-xs text-faint">
                            {item.event.notes}
                          </span>
                        )}
                        <ReminderChip reminders={item.event.reminders} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{eventWhenPill(item.event)}</td>
                    <td className="px-4 py-2.5 text-xs text-faint">
                      {item.event.source} · {shortDate(new Date(item.event.createdAt))}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={item.task.id}
                    onClick={() => openDetail("task", item.task.id)}
                    className={`cursor-pointer border-b border-edge/50 transition-colors last:border-0 hover:bg-surface-2/40 ${
                      fresh?.has(item.task.id) ? "animate-task-in" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <CheckButton t={item.task} onDone={onDone} />
                        <span
                          className={`cross-off ${crossing.has(item.task.id) ? "crossed text-faint" : ""}`}
                        >
                          {item.task.title}
                        </span>
                        <StageDots stages={item.task.stages} />
                        <RepeatChip recurrence={item.task.recurrence} />
                        <ReminderChip reminders={item.task.reminders} />
                        <ProvenanceLink t={item.task} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{whenPill(item.task)}</td>
                    <td className="px-4 py-2.5 text-xs text-faint">{sourceLabel(item.task)}</td>
                  </tr>
                )
              )}
              {g.done.map((t) => (
                <tr key={t.id} className="border-b border-edge/50 last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-ok/50 bg-ok/20 text-ok">
                        <Check size={12} strokeWidth={2.5} />
                      </span>
                      <span className="text-faint line-through">{t.title}</span>
                      <ProvenanceLink t={t} />
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Pill tone="ok">done</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint">{sourceLabel(t)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
