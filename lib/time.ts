// Timezone math for briefings and due-date logic. The user's IANA timezone is
// load-bearing: "today", "overdue", and every briefing computation runs in it,
// never in server time.

/** Offset (ms) of `tz` from UTC at the instant `date`. */
export function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC instants bounding "today" in the user's timezone. */
export function dayRangeInTz(tz: string, now: Date = new Date()): { start: Date; end: Date } {
  const offset = tzOffsetMs(tz, now);
  const local = new Date(now.getTime() + offset);
  const startLocalUtcMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  );
  const start = new Date(startLocalUtcMs - offset);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * An ISO 8601 date or date-time read the way the user means it. With an
 * offset or Z it is that instant. Without one it is wall-clock time in `tz`,
 * and a date alone is midnight there: a bare `new Date("2026-10-07T08:00:00")`
 * reads it in the server's zone instead, which is UTC on Heroku, so "8 am"
 * was stored as 1 am Pacific. Anything else is left to Date. Null when
 * unparseable.
 */
export function parseInTz(iso: string, tz: string): Date | null {
  const s = iso.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(s);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  if (Number.isNaN(wall)) return null;
  // The offset at the first guess, then at the corrected instant: across a
  // DST change the two differ, and the second is the right one.
  const guess = wall - tzOffsetMs(tz, new Date(wall));
  return new Date(wall - tzOffsetMs(tz, new Date(guess)));
}

/** The wall-clock time of `date` in `tz` as "YYYY-MM-DDTHH:mm:ss", no offset: Google Calendar's dateTime beside a timeZone. */
export function wallTimeInTz(date: Date, tz: string): string {
  const local = new Date(date.getTime() + tzOffsetMs(tz, date));
  return local.toISOString().slice(0, 19);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
