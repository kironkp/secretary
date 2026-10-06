"use client";

// Phase 9: month-grid calendar over real events + task due dates. Days are
// the user's calendar days in their timezone (lib/due.ts, SEC-A006), the
// same days every other screen counts, not the browser's.
import { useMemo, useState } from "react";
import { localDay } from "@/lib/due";
import { isOverdue, openDetail, type EventRow, type TaskRow } from "./shared";

const DAY = 86_400_000;

export function CalendarView({ tasks, events, timezone }: { tasks: TaskRow[]; events: EventRow[]; timezone: string }) {
  const todayN = localDay(new Date(), timezone);
  const todayAt = new Date(todayN * DAY);
  const [cursor, setCursor] = useState({ y: todayAt.getUTCFullYear(), m: todayAt.getUTCMonth() });

  // A cell is a day number (days since 1970-01-01 of a calendar date); the
  // Date it carries is that date at UTC midnight, read with UTC getters only.
  const first = new Date(Date.UTC(cursor.y, cursor.m, 1));
  const startWeekday = first.getUTCDay(); // 0 = Sunday
  const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: startWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(Date.UTC(cursor.y, cursor.m, i + 1))),
  ];

  const byDay = useMemo(() => {
    const evs = new Map<number, EventRow[]>();
    for (const e of events) {
      const n = localDay(new Date(e.startsAt), timezone);
      evs.set(n, [...(evs.get(n) ?? []), e]);
    }
    const tks = new Map<number, TaskRow[]>();
    for (const t of tasks) {
      if (!t.dueAt || ["done", "dropped"].includes(t.status)) continue;
      const n = localDay(new Date(t.dueAt), timezone);
      tks.set(n, [...(tks.get(n) ?? []), t]);
    }
    return { evs, tks };
  }, [tasks, events, timezone]);

  const itemsOn = (d: Date) => {
    const n = d.getTime() / DAY;
    return { dayEvents: byDay.evs.get(n) ?? [], dayTasks: byDay.tks.get(n) ?? [] };
  };

  const isToday = (d: Date) => d.getTime() / DAY === todayN;

  return (
    <div className="rounded-xl border border-edge bg-surface p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <button
          onClick={() =>
            setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))
          }
          aria-label="Previous month"
          className="rounded-md px-2.5 py-1 text-sm text-muted hover:bg-card hover:text-ink"
        >
          ‹
        </button>
        <p className="text-sm font-bold">
          {new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(first)}
        </p>
        <button
          onClick={() =>
            setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))
          }
          aria-label="Next month"
          className="rounded-md px-2.5 py-1 text-sm text-muted hover:bg-card hover:text-ink"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px text-center text-[11px] font-bold uppercase tracking-wide text-faint">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-edge/50">
        {cells.map((d, i) => {
          if (!d) return <div key={`pad-${i}`} className="min-h-[72px] bg-surface" />;
          const { dayEvents, dayTasks } = itemsOn(d);
          return (
            <div
              key={d.toISOString()}
              className={`min-h-[72px] bg-surface p-1.5 ${isToday(d) ? "bg-card" : ""}`}
            >
              <p
                className={`mb-1 text-right text-[11px] ${
                  isToday(d)
                    ? "font-bold text-accent"
                    : d.getUTCDay() === 0 || d.getUTCDay() === 6
                      ? "text-faint"
                      : "text-muted"
                }`}
              >
                {d.getUTCDate()}
              </p>
              {dayEvents.slice(0, 2).map((e) => (
                <p
                  key={e.id}
                  title={e.title}
                  onClick={() => openDetail("event", e.id)}
                  className="mb-0.5 cursor-pointer truncate rounded bg-accent/15 px-1 py-px text-[10px] leading-tight text-accent hover:bg-accent/25"
                >
                  {e.title}
                </p>
              ))}
              {dayTasks.slice(0, 2).map((t) => (
                <p
                  key={t.id}
                  title={t.title}
                  onClick={() => openDetail("task", t.id)}
                  className={`mb-0.5 cursor-pointer truncate rounded px-1 py-px text-[10px] leading-tight ${
                    isOverdue(t) ? "bg-danger/15 text-danger hover:bg-danger/25" : "bg-surface-2 text-muted hover:bg-surface-2/70"
                  }`}
                >
                  {t.title}
                </p>
              ))}
              {dayEvents.length + dayTasks.length > 4 && (
                <p className="text-[10px] text-faint">+{dayEvents.length + dayTasks.length - 4}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
