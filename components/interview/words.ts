// The words on the Interview that are not a question: the count line above
// the title and the line at the bottom. Pure, so they are tested without a
// browser (tests/understanding-interview.test.ts). Days and counts are digits
// (docs/understanding/SPEC.md §7).

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "3 minutes ago", "yesterday", "not yet". Coarse on purpose: the line says
 * whether the reading is fresh, not when to the second.
 */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "not yet";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "not yet";
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour", "hours")} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "2 answered today · last read 3 minutes ago" */
export function footerLine(answeredToday: number, lastRunAt: string | null, now: Date): string {
  return `${answeredToday} answered today · last read ${relativeTime(lastRunAt, now)}`;
}

/**
 * "Question 4 of 14 · Caltrans": the count is progress through the sitting,
 * not a position in the stored queue. `done` is how many were answered on
 * this screen and `waiting` how many are still open, so the total holds
 * still as questions are answered and only moves when a reading adds some
 * or another surface answers one. Nothing waiting is said plainly.
 */
export function progressLine(done: number, waiting: number, project: string | null): string {
  if (waiting === 0) return "Nothing waiting";
  const line = `Question ${done + 1} of ${done + waiting}`;
  return project ? `${line} · ${project}` : line;
}
