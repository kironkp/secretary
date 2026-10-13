// LayoutPlan types + DEFAULT_PLAN (SPEC §2–§3). The plan is DATA: a planner
// emits it, the validator checks it, the renderer executes it. No planner
// string ever reaches markup unescaped.
import { z } from "zod";
import { isRegistryComponent, type RegistryComponent } from "./registry";
import type { ProjectSignal, Signals } from "./signals";
import type { LayoutPreference } from "./validator";
import { byUrgency, type Urgency } from "@/lib/project-order";

export const planSectionSchema = z
  .object({
    component: z.string(), // registry membership checked by the validator (unknown → section dropped)
    props: z.record(z.string(), z.unknown()).optional(),
    why: z.string().max(140).optional(),
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
};
export type WishlistEntry = { need: string; closest_component: string; signals: string };
export type LayoutPlan = {
  plan_id: string;
  reason_summary?: string | null;
  sections: PlanSection[];
  wishlist?: WishlistEntry[];
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

/** The cards' order: urgent projects first, then the rest, each in the one urgency order; lists last. */
const cardOrder = (a: ProjectSignal, b: ProjectSignal): number =>
  Number(a.kind === "list") - Number(b.kind === "list") ||
  Number(isUrgent(b)) - Number(isUrgent(a)) ||
  byUrgency(urgencyOf(a), urgencyOf(b));

/**
 * Invariant 4, presence (SPEC §3, v1.02): a plan that has come to lack the
 * card of an urgent project gets it back, and nothing else moves. The card
 * goes after the last urgent card (at the end of the cards when there is
 * none), with a why the user can read. This is how a stored plan is kept
 * when a project goes late after the user arranged the board, or after he
 * hid its card: the arrangement survives, and the late work is on screen.
 * Pure; returns the same plan when nothing is missing.
 */
export function withUrgentCards(plan: LayoutPlan, signals: Signals): LayoutPlan {
  const idOf = (s: PlanSection) => String(s.props?.project_id ?? "");
  const urgent = signals.projects.filter(isUrgent);
  const have = new Set(plan.sections.filter((s) => s.component === "project_card").map(idOf));
  const missing = urgent.filter((p) => !have.has(p.id)).toSorted(cardOrder);
  if (!missing.length) return plan;
  const urgentIds = new Set(urgent.map((p) => p.id));
  const sections = [...plan.sections];
  for (const p of missing) {
    const cards = sections.flatMap((s, i) => (s.component === "project_card" ? [i] : []));
    const lastUrgent = cards.filter((i) => urgentIds.has(idOf(sections[i]))).at(-1);
    const after = lastUrgent ?? cards.at(-1) ?? sections.length - 1;
    const late = typeof p.soonest_days === "number" && p.soonest_days < 0;
    sections.splice(after + 1, 0, {
      component: "project_card",
      props: { project_id: p.id, variant: "full" },
      why: late ? "Back on your board: it has late work" : "Back on your board: it is due within a week",
    });
  }
  return { ...plan, sections };
}

/** Is a project card that is not urgent ahead of one that is, anywhere among the plan's cards? */
export function quietAheadOfUrgent(plan: LayoutPlan, signals: Signals): boolean {
  const urgent = new Set(signals.projects.filter(isUrgent).map((p) => p.id));
  let quietSeen = false;
  for (const s of plan.sections) {
    if (s.component !== "project_card") continue;
    if (!urgent.has(String(s.props?.project_id ?? ""))) quietSeen = true;
    else if (quietSeen) return true;
  }
  return false;
}

/**
 * The two names a plan the user arranged carries: arrange_dashboard (voice,
 * a tap) writes `user-…` (lib/layout/arrange.ts) and the chat's
 * edit_layout_plan writes `chat-…` (lib/secretary/tools.ts). Everything else
 * is the system's: `default`, `rules-…`, `llm-…`.
 */
export const arrangedByUser = (planId: string): boolean => /^(user|chat)-/.test(planId);

/**
 * Is this stored plan the user's own? The one place that says (SPEC §3
 * invariants 4 and 7): he arranged it (either name above; a chat edit pins
 * nothing, so the name is all it has), or it carries a pin of his, wherever
 * the pin is kept: on the plan's row (`pinned`) or as a pin_section
 * preference. A pin on a section that is not in the plan is not a pin on it.
 */
export function isUsersPlan(plan: LayoutPlan, pinned: string[], preferences: LayoutPreference[]): boolean {
  if (arrangedByUser(plan.plan_id)) return true;
  const pins = new Set([...pinned, ...preferences.filter((p) => p.kind === "pin_section").map((p) => p.value.section)]);
  return plan.sections.some((s) => pins.has(sectionKey(s)));
}

/**
 * Whether a STORED plan is kept as it stands (SPEC §3 invariant 4, v1.02).
 * Always when it is the user's own (isUsersPlan). A plan the system wrote
 * (planner, rules, default) only while it has no card that is not urgent
 * ahead of an urgent one, counting the cards an urgent project is owed;
 * once it has, it is not kept and the default is shown, like any other
 * stored plan that fails. The system's own stale order is nobody's to
 * protect.
 */
export function standsAsStored(plan: LayoutPlan, pinned: string[], preferences: LayoutPreference[], signals: Signals): boolean {
  return isUsersPlan(plan, pinned, preferences) || !quietAheadOfUrgent(withUrgentCards(plan, signals), signals);
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
