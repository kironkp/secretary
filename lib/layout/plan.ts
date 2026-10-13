// LayoutPlan types + DEFAULT_PLAN (SPEC §2–§3). The plan is DATA: a planner
// emits it, the validator checks it, the renderer executes it. No planner
// string ever reaches markup unescaped.
import { z } from "zod";
import { isRegistryComponent, type RegistryComponent } from "./registry";
import type { ProjectSignal, Signals } from "./signals";
import { byUrgency, type Urgency } from "@/lib/project-order";

export const planSectionSchema = z
  .object({
    component: z.string(), // registry membership checked by the validator (unknown → section dropped)
    props: z.record(z.string(), z.unknown()).optional(),
    why: z.string().max(140).optional(),
    // Where the user pinned it (SPEC §2, composition): the n-th section from
    // the top of the board, or its last place. Written by the app, never read
    // from a planner.
    place: z
      .union([z.object({ from: z.enum(["top", "bottom"]), n: z.number().int().min(0) }), z.number().int().min(0), z.literal("last")])
      .optional(),
  })
  .strict();

export const layoutPlanSchema = z
  .object({
    plan_id: z.string(),
    reason_summary: z.string().max(120).nullable().optional(),
    // DEFAULT_PLAN carries a card per project, so the cap must hold a real
    // board: at 14, nine projects and a list (Kiron's) made 15 sections, his
    // default never validated, and every render fell back to the stored head
    // (SEC-A007). 40 still stops a runaway planner.
    sections: z.array(planSectionSchema).min(1).max(40),
    wishlist: z
      .array(
        z.object({
          need: z.string(),
          closest_component: z.string(),
          signals: z.string(),
        })
      )
      .optional(),
  })
  .strict();

export type PlanSection = {
  // A base registry component, or the name of an approved dynamic component
  // (SPEC v1.3) — validated against the dynamic list, never free-form.
  component: RegistryComponent | (string & {});
  props?: Record<string, unknown>;
  why?: string;
  /**
   * The place of a section he placed (SPEC §2): its position on the board he
   * was last told, counted from the top or from the bottom, the banner not
   * counted. A bare number or "last" is how rounds 3 and 4 wrote it (asPlace).
   */
  place?: Place | number | "last";
};
export type WishlistEntry = { need: string; closest_component: string; signals: string };
export type LayoutPlan = {
  plan_id: string;
  reason_summary?: string | null;
  sections: PlanSection[];
  wishlist?: WishlistEntry[];
  /**
   * On every row stored since v1.02 r5 (written by the store, never by a
   * planner): the row is a composed board. A row without it was written
   * before, and is not a board "Put it back" returns to (SPEC §2).
   */
  composed?: true;
};

/**
 * Stable identity for a section within a plan — what pinning and the
 * pinned-section validator pass key on. Repeatable components (project_card)
 * are distinguished by their subject id.
 */
export function sectionKey(s: { component: string; props?: Record<string, unknown> }): string {
  const pid = s.props?.project_id;
  return typeof pid === "string" ? `${s.component}:${pid}` : s.component;
}

/** A project's urgency from its signals; days_left stands in for a fixture without the newer fields. */
const urgencyOf = (p: ProjectSignal): Urgency => ({
  name: p.name,
  list: p.kind === "list",
  soonest: p.soonest_days ?? null,
  deadline: p.deadline_days !== undefined ? p.deadline_days : p.days_left,
});

/**
 * SPEC §3 invariant 4: a project is urgent when it has late open work, or its
 * date is within the week. A list is never urgent: it is not work to chase.
 */
export function isUrgent(p: ProjectSignal): boolean {
  if (p.kind === "list") return false;
  const late = typeof p.soonest_days === "number" && p.soonest_days < 0;
  return late || (p.days_left !== null && p.days_left <= 7);
}

/** How urgent, in words for a refusal: "5d late", "3d". */
export function urgencyLabel(p: ProjectSignal): string {
  return typeof p.soonest_days === "number" && p.soonest_days < 0 ? `${-p.soonest_days}d late` : `${p.days_left}d`;
}

/**
 * The order of the cards the user did not place (SPEC §2): urgent projects
 * first, then the rest, each in the one urgency order. Lists come last
 * without a term of their own: a list is never urgent, and the urgency
 * order (lib/project-order.ts) puts lists after projects.
 */
export const cardOrder = (a: ProjectSignal, b: ProjectSignal): number =>
  Number(isUrgent(b)) - Number(isUrgent(a)) || byUrgency(urgencyOf(a), urgencyOf(b));

/**
 * Calendar days, in the user's zone, to the date that makes a project
 * pressing: the count the date beside the chip uses (lib/due.ts). days_left
 * counts whole 24-hour periods, so at 7 PM a task due tomorrow at 5 PM is
 * "0 days" by it, and the chip said "Due in 0 days" beside "tomorrow".
 * A committed deadline is the project's own date; otherwise the nearest date
 * that is not already past; and for a fixture or an event with neither,
 * days_left as before. Null when the project has no such date at all.
 */
function calendarDays(p: ProjectSignal): number | null {
  if (p.deadline_type === "committed" && typeof p.deadline_days === "number") return p.deadline_days;
  const ahead = [p.soonest_days, p.deadline_days].filter((d): d is number => typeof d === "number" && d >= 0);
  return ahead.length ? Math.min(...ahead) : (p.days_left ?? null);
}
const COMMITTED_WHY = " — you committed to this date";

/**
 * Rule 1's why (SPEC §5): "Due today", "Due tomorrow", "Due in N days", in
 * calendar days. Null for a project with no date to count to.
 */
export function deadlineWhy(p: ProjectSignal): string | null {
  const days = calendarDays(p);
  if (days === null) return null;
  // A committed date already past says how late it is, in the words the date beside it uses (lib/due.ts).
  const due = days < 0 ? `${-days} ${days === -1 ? "day" : "days"} late` : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`;
  return `${due}${p.deadline_type === "committed" ? COMMITTED_WHY : ""}`;
}

/**
 * Whether a why is one rule 1 wrote, on any day, the wording before v1.02
 * ("Due in 0 days", "Due in 1 day") included. Such a why counts days, so
 * the composition writes it again with today's count at every render: a
 * plan served from the cache was written when the count was different.
 */
export function isDeadlineWhy(why: string | undefined | null): boolean {
  return !!why && /^(Due (today|tomorrow|in \d+ days?)|\d+ days? late)( — you committed to this date)?$/.test(why);
}

const BACK_ON_BOARD = "Back on your board: ";
/** The why on a card the user hid that is back because its project is urgent (invariant 4, presence). */
export function backOnBoardWhy(p: ProjectSignal): string {
  const late = typeof p.soonest_days === "number" && p.soonest_days < 0;
  return `${BACK_ON_BOARD}${late ? "it has late work" : "it is due within a week"}`;
}
/** Whether a why is the composition's own "Back on your board": written again or dropped at each render, never read back. */
export function isBackOnBoardWhy(why: string | undefined | null): boolean {
  return !!why && why.startsWith(BACK_ON_BOARD);
}

/** A place on the board: the n-th section from the top, or from the bottom, the banner not counted. */
export type Place = { from: "top" | "bottom"; n: number };
/** A stored place as a Place: rounds 3 and 4 wrote a bare number (from the top) or "last". */
export function asPlace(place: PlanSection["place"]): Place | null {
  if (place === undefined || place === null) return null;
  if (place === "last") return { from: "bottom", n: 0 };
  return typeof place === "number" ? { from: "top", n: place } : place;
}

/**
 * DEFAULT_PLAN (SPEC §2): also the fallback and the calm-mode plan. Depends on
 * the user's active projects, so it's a function of signals. Deterministic:
 * same signals → deep-equal plan (F1 relies on this).
 */
export function defaultPlan(signals: Signals): LayoutPlan {
  return {
    plan_id: "default",
    reason_summary: null,
    sections: [
      { component: "hero_next_up" },
      { component: "stat_row" },
      // The projects progress strip (registry v3, SEC-A007), above the cards it sums up.
      { component: "timeline", props: { span_days: 21, expanded: false } },
      // Urgent projects first (§3 invariant 4: the default never has a
      // card that is not urgent ahead of one that is), then the rest, each
      // in the order the strip and the Timeline use (lib/project-order.ts):
      // late first by how late, then the nearest date, then undated; lists
      // (Shopping) last.
      ...signals.projects
        .filter((p) => !p.parent_id)
        .toSorted(cardOrder)
        .map((p): PlanSection => ({
          component: "project_card",
          props: { project_id: p.id, variant: "full" },
        })),
      { component: "date_chase" },
      { component: "people_index" },
    ],
  };
}

/** Section-order fingerprint: two plans with the same order compare equal. */
export function sectionOrder(plan: LayoutPlan): string {
  return plan.sections.map(sectionKey).join("|");
}

export function isPlanSection(s: unknown): s is PlanSection {
  return (
    typeof s === "object" &&
    s !== null &&
    isRegistryComponent((s as { component?: unknown }).component)
  );
}
