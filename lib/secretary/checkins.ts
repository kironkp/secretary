// Check-ins: standing questions Secretary asks on given weekdays, in
// conversation only (lib/db/schema.ts `standingCheckins`). The briefing lists the
// ones due today; the model calls checkin_asked once it has asked.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { standingCheckins as checkins } from "@/lib/db/schema";

export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayName = (typeof DAY_NAMES)[number];

/** The user's wall-calendar date (YYYY-MM-DD) and weekday (0 = Sunday) at `now`. */
export function localDay(tz: string, now: Date = new Date()): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: DAY_NAMES.indexOf(get("weekday").toLowerCase() as DayName),
  };
}

/** "Thursdays", "Mondays and Thursdays", "every day". */
export function daysInWords(days: number[]): string {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 7) return "every day";
  const names = sorted.map((d) => `${DAY_NAMES[d][0].toUpperCase()}${DAY_NAMES[d].slice(1)}s`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every check-in, and which of them are still to be asked today. */
export async function checkinsFor(userId: string, tz: string, now: Date = new Date()) {
  const rows = await db.select().from(checkins).where(eq(checkins.userId, userId));
  const today = localDay(tz, now);
  const due = rows.filter((r) => r.days.includes(today.weekday) && r.lastAskedOn !== today.date);
  return { all: rows, due, today };
}

/** A check-in by id, or by a fragment of its question. */
export async function findCheckin(userId: string, ref: string) {
  const rows = await db.select().from(checkins).where(eq(checkins.userId, userId));
  const needle = ref.trim().toLowerCase();
  return (
    rows.find((r) => r.id === ref.trim()) ??
    rows.find((r) => r.question.toLowerCase() === needle) ??
    rows.find((r) => r.question.toLowerCase().includes(needle) || needle.includes(r.question.toLowerCase())) ??
    null
  );
}

export async function markAsked(userId: string, id: string, date: string) {
  await db
    .update(checkins)
    .set({ lastAskedOn: date })
    .where(and(eq(checkins.userId, userId), eq(checkins.id, id)));
}
