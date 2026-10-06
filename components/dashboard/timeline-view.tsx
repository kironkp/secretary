"use client";

// Phase 9: vertical timeline — overdue first, then everything with a date over
// the next 30 days, day by day.
import { Calendar } from "lucide-react";
import {
  CheckButton,
  ProvenanceLink,
  ReminderChip,
  dueText,
  isOverdue,
  openDetail,
  type EventRow,
  type TaskRow,
} from "./shared";

type Entry =
  | { kind: "task"; at: Date; days: number; task: TaskRow }
  | { kind: "event"; at: Date; days: number; event: EventRow };

export function TimelineView({
  tasks,
  events,
  crossing,
  onDone,
  timezone,
}: {
  tasks: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  timezone: string;
}) {
  // Days are the user's calendar days (lib/due.ts, SEC-A006), worked out on
  // the server: the same "past due" and "today" every other screen says.
  const entries: Entry[] = [
    ...tasks
      .filter((t) => t.dueAt && t.dueDays !== null && !["done", "dropped"].includes(t.status))
      .map((t) => ({ kind: "task" as const, at: new Date(t.dueAt!), days: t.dueDays!, task: t })),
    ...events
      .filter((e) => e.startDays >= 0)
      .map((e) => ({ kind: "event" as const, at: new Date(e.startsAt), days: e.startDays, event: e })),
  ]
    .filter((e) => e.days <= 30)
    .sort((a, b) => a.days - b.days || a.at.getTime() - b.at.getTime());

  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-edge bg-surface px-4 py-8 text-center text-sm text-muted">
        Nothing dated in the next 30 days.
      </p>
    );
  }

  // group by calendar day
  const groups = new Map<number, Entry[]>();
  for (const e of entries) groups.set(e.days, [...(groups.get(e.days) ?? []), e]);

  const dayLabel = (d: Date, days: number) => {
    if (days === 0) return "Today";
    const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timezone }).format(d);
    return days < 0 ? `${date} — past due` : date;
  };

  return (
    <div className="relative space-y-4 pl-5">
      <div className="absolute bottom-1 left-1.5 top-1 w-px bg-edge" aria-hidden />
      {[...groups.entries()].map(([key, dayEntries]) => {
        const at = dayEntries[0].at;
        const anyOverdue = dayEntries.some((e) => e.kind === "task" && isOverdue(e.task));
        return (
          <div key={key} className="relative">
            <span
              className={`absolute -left-5 top-1 h-3 w-3 rounded-full border-2 ${
                anyOverdue ? "border-danger bg-danger/30" : "border-accent bg-surface"
              }`}
              aria-hidden
            />
            <p
              className={`mb-1.5 text-xs font-bold uppercase tracking-wide ${
                anyOverdue ? "text-danger" : "text-muted"
              }`}
            >
              {dayLabel(at, key)}
            </p>
            <div className="space-y-1.5">
              {dayEntries.map((e) =>
                e.kind === "event" ? (
                  <div
                    key={`e-${e.event.id}`}
                    onClick={() => openDetail("event", e.event.id)}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm transition-colors hover:border-faint"
                  >
                    <Calendar size={14} strokeWidth={1.75} className="flex-none text-muted" />
                    <span>{e.event.title}</span>
                    <span className="text-xs text-faint">
                      {new Intl.DateTimeFormat("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(e.at)}
                      {e.event.location ? ` · ${e.event.location}` : ""}
                    </span>
                    <ReminderChip reminders={e.event.reminders} />
                  </div>
                ) : (
                  <div
                    key={`t-${e.task.id}`}
                    onClick={() => openDetail("task", e.task.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm transition-colors hover:border-faint ${
                      isOverdue(e.task) ? "border-danger/50" : "border-edge"
                    }`}
                  >
                    <CheckButton t={e.task} onDone={onDone} />
                    <span className={`cross-off ${crossing.has(e.task.id) ? "crossed text-faint" : ""}`}>
                      {e.task.title}
                    </span>
                    {isOverdue(e.task) && (
                      <span className="text-xs text-danger">{dueText(e.task)}</span>
                    )}
                    {e.task.postponedCount > 0 && (
                      <span className="text-xs text-warn">pushed {e.task.postponedCount}×</span>
                    )}
                    <ReminderChip reminders={e.task.reminders} />
                    <ProvenanceLink t={e.task} />
                  </div>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
