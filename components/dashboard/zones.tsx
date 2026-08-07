"use client";

// The fixed component palette the adaptive layout engine arranges (A-4), plus
// the suggested/procrastination zones (P-1…P-3) shown on classic views too.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckButton, fmtDue, isOverdue, type EventRow, type TaskRow } from "./shared";

const OPEN = new Set(["inbox", "todo", "in_progress", "blocked"]);

export function OverdueCallout({ tasks }: { tasks: TaskRow[] }) {
  const overdue = tasks.filter(isOverdue);
  if (overdue.length === 0) return null;
  return (
    <div className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm">
      <span className="font-bold text-danger">⚠ Overdue ({overdue.length})</span>
      <span className="ml-2 text-muted">
        {overdue.map((t) => `${t.title} (${fmtDue(t.dueAt)})`).join(" · ")}
      </span>
    </div>
  );
}

function computeStats(tasks: TaskRow[], events: EventRow[]) {
  const now = Date.now();
  const openTasks = tasks.filter((t) => OPEN.has(t.status));
  return {
    open: openTasks,
    overdue: tasks.filter(isOverdue).length,
    dueToday: openTasks.filter((t) => {
      if (!t.dueAt) return false;
      const d = new Date(t.dueAt).getTime();
      return d >= now && d < now + 86400000;
    }).length,
    done7d: tasks.filter(
      (t) => t.status === "done" && now - new Date(t.updatedAt).getTime() < 7 * 86400000
    ).length,
    nextEvent: events
      .filter((e) => new Date(e.startsAt).getTime() >= now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0],
  };
}

export function StatTiles({ tasks, events }: { tasks: TaskRow[]; events: EventRow[] }) {
  const { open, overdue, dueToday, done7d, nextEvent } = useMemo(
    () => computeStats(tasks, events),
    [tasks, events]
  );

  const tiles: { label: string; value: string; cls?: string }[] = [
    { label: "open", value: String(open.length) },
    { label: "overdue", value: String(overdue), cls: overdue ? "text-danger" : undefined },
    { label: "due today", value: String(dueToday), cls: dueToday ? "text-warn" : undefined },
    { label: "done this week", value: String(done7d), cls: done7d ? "text-ok" : undefined },
    ...(nextEvent
      ? [
          {
            label: "next up",
            value: `${nextEvent.title} · ${new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(nextEvent.startsAt))}`,
          },
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-edge bg-surface px-4 py-3">
          <p className={`truncate text-lg font-bold ${t.cls ?? ""}`}>{t.value}</p>
          <p className="text-xs text-faint">{t.label}</p>
        </div>
      ))}
    </div>
  );
}

export function FocusCard({
  tasks,
  crossing,
  onDone,
}: {
  tasks: TaskRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  const open = tasks.filter((t) => OPEN.has(t.status));
  const focus =
    open
      .filter(isOverdue)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0] ??
    open
      .filter((t) => t.dueAt)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0] ??
    open.sort((a, b) => b.priority - a.priority)[0];
  if (!focus) return null;
  const crossingNow = crossing.has(focus.id);
  return (
    <div className="rounded-xl border border-accent/40 bg-surface px-4 py-3.5">
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-accent">🎯 Focus</p>
      <div className="flex items-center gap-2.5">
        <CheckButton t={focus} onDone={onDone} />
        <span className={`text-sm font-semibold cross-off ${crossingNow ? "crossed text-faint" : ""}`}>
          {focus.title}
        </span>
        {focus.dueAt && (
          <span className={`text-xs ${isOverdue(focus) ? "text-danger" : "text-muted"}`}>
            {fmtDue(focus.dueAt)}
          </span>
        )}
        {focus.postponedCount > 0 && (
          <span className="text-xs text-warn">pushed {focus.postponedCount}×</span>
        )}
      </div>
    </div>
  );
}

export function CalendarStrip({ events }: { events: EventRow[] }) {
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => {
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
              <p key={e.id} className="mb-0.5 truncate text-xs">
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

export function ProcrastinationZone({ tasks }: { tasks: TaskRow[] }) {
  const offenders = tasks
    .filter((t) => OPEN.has(t.status) && t.procrastinationScore >= 3)
    .sort((a, b) => b.procrastinationScore - a.procrastinationScore)
    .slice(0, 5);
  if (offenders.length === 0) return null;
  return (
    <div className="rounded-xl border border-warn/40 bg-surface px-4 py-3.5">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-warn">😬 Procrastinating</p>
      {offenders.map((t) => (
        <p key={t.id} className="mb-1 text-sm last:mb-0">
          {t.title}{" "}
          <span className="text-xs text-faint">
            {[
              t.postponedCount ? `pushed ${t.postponedCount}×` : null,
              isOverdue(t) ? fmtDue(t.dueAt) : null,
            ]
              .filter(Boolean)
              .join(" · ") || "stalling"}
          </span>
        </p>
      ))}
    </div>
  );
}

export function SuggestedZone({ suggestions }: { suggestions: TaskRow[] }) {
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, status: "todo" | "dropped") => {
    setBusy(id);
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(null);
    if (res.ok) {
      setHidden((h) => new Set(h).add(id));
      router.refresh();
    }
  };

  const visible = suggestions.filter((s) => !hidden.has(s.id));
  if (visible.length === 0) return null;
  return (
    <div className="rounded-xl border border-ok/40 bg-surface px-4 py-3.5">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ok">✨ Suggested</p>
      {visible.map((s) => (
        <div key={s.id} className="mb-2 flex flex-wrap items-center gap-2 text-sm last:mb-0">
          <span>{s.title}</span>
          {s.notes && (
            <span className="text-xs text-faint">{s.notes.replace(/^Suggested: /, "")}</span>
          )}
          <span className="ml-auto flex gap-1.5">
            <button
              disabled={busy === s.id}
              onClick={() => act(s.id, "todo")}
              className="rounded-full border border-ok/50 px-2.5 py-0.5 text-xs text-ok hover:bg-ok/10 disabled:opacity-50"
            >
              ✓ add
            </button>
            <button
              disabled={busy === s.id}
              onClick={() => act(s.id, "dropped")}
              className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
            >
              ✗ dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProjectGrid({ tasks }: { tasks: TaskRow[] }) {
  const byProject = new Map<string, { color: string | null; open: TaskRow[]; done: number }>();
  for (const t of tasks) {
    if (!t.projectName) continue;
    const entry = byProject.get(t.projectName) ?? { color: t.projectColor, open: [], done: 0 };
    if (OPEN.has(t.status)) entry.open.push(t);
    if (t.status === "done") entry.done++;
    byProject.set(t.projectName, entry);
  }
  if (byProject.size === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {[...byProject.entries()].map(([name, p]) => (
        <div key={name} className="rounded-xl border border-edge bg-surface px-4 py-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-sm font-bold">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? "#7aa2ff" }} />
            {name}
            <span className="ml-auto text-xs font-normal text-faint">
              {p.open.length} open{p.done ? ` · ${p.done} done` : ""}
            </span>
          </p>
          {p.open.slice(0, 4).map((t) => (
            <p key={t.id} className="truncate text-xs text-muted">
              {t.title}
              {t.dueAt && (
                <span className={isOverdue(t) ? "text-danger" : " text-faint"}> · {fmtDue(t.dueAt)}</span>
              )}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
