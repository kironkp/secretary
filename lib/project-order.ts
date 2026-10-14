// One order for projects on every screen (SEC-A007, sec rev; his own order
// since v1.11, docs/projects/SPEC.md §1): the Overview's cards, its progress
// strip, the Timeline's lanes and the Projects tab. Lists after projects; then
// the ones he placed, in his order; then urgent first; then the urgency
// order: late first, the most overdue at the top; then the nearest upcoming
// date (an open task's due date or the project's own deadline); then projects
// with no date; then by name. Days are the user's calendar days from today
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

/** What the one order reads: the urgency, whether it is urgent, and his place for it. */
export type Ordered = Urgency & {
  /** Urgent (docs/adaptive-ui/SPEC.md §3 invariant 4): stands before what is not, among what he did not place. */
  urgent?: boolean;
  /** Where he put it in its group, 0 at the top; empty when he has not placed it. */
  position?: number | null;
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

const placed = (o: Ordered) => typeof o.position === "number";

/** The one order: lists after projects; his placed ones first, by place; then urgent first; then by urgency. */
export function byOrder(a: Ordered, b: Ordered): number {
  return (
    Number(!!a.list) - Number(!!b.list) ||
    Number(placed(b)) - Number(placed(a)) ||
    (placed(a) && placed(b) ? a.position! - b.position! : 0) ||
    Number(!!b.urgent) - Number(!!a.urgent) ||
    byUrgency(a, b)
  );
}
