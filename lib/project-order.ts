// One order for projects on every screen (SEC-A007, sec rev): the Overview's
// cards, its progress strip and the Timeline's lanes. Late first, the most
// overdue at the top; then the nearest upcoming date (an open task's due date
// or the project's own deadline); then projects with no date; lists
// (Shopping) last; then by name. Days are the user's calendar days from today
// (lib/due.ts), negative when late. Pure: the server's plan and the client's
// lanes sort with the same code, so they cannot disagree.

export type Urgency = {
  name: string;
  /** A list is not work to chase: it sorts after every project. */
  list?: boolean;
  /** Calendar days to the earliest open dated task: negative when it is late. */
  soonest: number | null;
  /** Calendar days to the project's own deadline, if it has one. */
  deadline?: number | null;
};

const NONE = Number.MAX_SAFE_INTEGER;

/** The project's most pressing date, in days from today; no date sorts last. */
export function urgencyKey(u: Urgency): number {
  const days = [u.soonest, u.deadline].filter((d): d is number => typeof d === "number");
  return days.length ? Math.min(...days) : NONE;
}

export function byUrgency(a: Urgency, b: Urgency): number {
  return Number(!!a.list) - Number(!!b.list) || urgencyKey(a) - urgencyKey(b) || a.name.localeCompare(b.name);
}
