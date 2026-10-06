// One due-date truth (SEC-A006, 2026-10-06). Every screen that says "past
// due", "today" or "N days late" asks this module, in the user's own
// timezone, by calendar day: Today, every Dashboard view, the Workspace and
// the project page. The Dashboard used to measure from this instant in the
// browser's zone, so a task due at 9 AM read "yesterday" at noon and the
// board counted 10 past due where Today counted 7.
//
// Calendar days, not 24-hour spans: on Nov 1 (the end of daylight time in
// the US) a day is 25 hours long, and a span-based count says a task due at
// 00:30 that day is two days late on Nov 2. Pure and clock-injectable, so
// the server and the client agree and tests can pin the hour.

/** Statuses that are still work. */
export const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
export const isOpenStatus = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);

/**
 * A suggestion Secretary made that the user has not taken up: source
 * "suggested" still in the inbox. Accepting it makes it "todo" (it keeps
 * the source), and then it is the user's work like any other.
 */
export const isWaitingSuggestion = (t: { source: string; status: string }): boolean =>
  t.source === "suggested" && t.status === "inbox";

/** An open task that counts as the user's work: not a suggestion still waiting. */
export const isOpenWork = (t: { source: string; status: string }): boolean =>
  isOpenStatus(t.status) && !isWaitingSuggestion(t);

const formats = new Map<string, Intl.DateTimeFormat>();
function ymd(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formats.set(tz, f);
  }
  return f;
}

/** The calendar day an instant falls on in `tz`, as a day count from 1970-01-01. */
export function localDay(at: Date, tz: string): number {
  const parts = Object.fromEntries(ymd(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
}

/** Calendar days from today to `at` in `tz`: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFromToday(at: Date, tz: string, now: Date = new Date()): number {
  return localDay(at, tz) - localDay(now, tz);
}

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Past due: open, dated, and due on a calendar day before today. A task due
 * earlier today is due today, never late.
 */
export function isPastDue(
  t: { dueAt: Date | string | null; status: string },
  tz: string,
  now: Date = new Date()
): boolean {
  const due = asDate(t.dueAt);
  return due !== null && isOpenStatus(t.status) && daysFromToday(due, tz, now) < 0;
}

/**
 * How a due date reads, the same on every screen: "3 days late", "1 day
 * late", "today", "tomorrow", a weekday within the week, else "Sep 3".
 * Days as words, never "3d" (docs/understanding/SPEC.md §7). Empty when
 * there is no date.
 */
export function dueLabel(due: Date | string | null | undefined, tz: string, now: Date = new Date()): string {
  const at = asDate(due);
  if (!at) return "";
  const days = daysFromToday(at, tz, now);
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} late`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(at);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }).format(at);
}
