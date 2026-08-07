"use client";

// Phase 9: vertical timeline — overdue first, then everything with a date over
// the next 30 days, day by day.
import {
  CheckButton,
  ProvenanceLink,
  fmtDue,
  isOverdue,
  type EventRow,
  type TaskRow,
} from "./shared";

type Entry =
  | { kind: "task"; at: Date; task: TaskRow }
  | { kind: "event"; at: Date; event: EventRow };

export function TimelineView({
  tasks,
  events,
  crossing,
  onDone,
}: {
  tasks: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 86400000);

  const entries: Entry[] = [
    ...tasks
      .filter((t) => t.dueAt && !["done", "dropped"].includes(t.status))
      .map((t) => ({ kind: "task" as const, at: new Date(t.dueAt!), task: t })),
    ...events
      .filter((e) => new Date(e.startsAt) >= new Date(now.getTime() - 86400000))
      .map((e) => ({ kind: "event" as const, at: new Date(e.startsAt), event: e })),
  ]
    .filter((e) => e.at <= horizon)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-edge bg-surface px-4 py-8 text-center text-sm text-muted">
        Nothing dated in the next 30 days.
      </p>
    );
  }

  // group by calendar day
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = new Intl.DateTimeFormat("en-CA", { dateStyle: "short" }).format(e.at);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  const dayLabel = (d: Date) => {
    const overdueDay = d.getTime() < now.getTime() - 86400000;
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return "Today";
    if (overdueDay) return `${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d)} — overdue`;
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(d);
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
              {dayLabel(at)}
            </p>
            <div className="space-y-1.5">
              {dayEntries.map((e) =>
                e.kind === "event" ? (
                  <div
                    key={`e-${e.event.id}`}
                    className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm"
                  >
                    <span>📅</span>
                    <span>{e.event.title}</span>
                    <span className="text-xs text-faint">
                      {new Intl.DateTimeFormat("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(e.at)}
                      {e.event.location ? ` · ${e.event.location}` : ""}
                    </span>
                  </div>
                ) : (
                  <div
                    key={`t-${e.task.id}`}
                    className={`flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm ${
                      isOverdue(e.task) ? "border-danger/50" : "border-edge"
                    }`}
                  >
                    <CheckButton t={e.task} onDone={onDone} />
                    <span className={`cross-off ${crossing.has(e.task.id) ? "crossed text-faint" : ""}`}>
                      {e.task.title}
                    </span>
                    {isOverdue(e.task) && (
                      <span className="text-xs text-danger">{fmtDue(e.task.dueAt)}</span>
                    )}
                    {e.task.postponedCount > 0 && (
                      <span className="text-xs text-warn">pushed {e.task.postponedCount}×</span>
                    )}
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
