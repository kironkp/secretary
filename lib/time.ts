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

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
