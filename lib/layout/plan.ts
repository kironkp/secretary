// LayoutPlan types + DEFAULT_PLAN (SPEC §2–§3). The plan is DATA: a planner
// emits it, the validator checks it, the renderer executes it. No planner
// string ever reaches markup unescaped.
import { z } from "zod";
import { isRegistryComponent, type RegistryComponent } from "./registry";
import type { Signals } from "./signals";

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
      // Most urgent first (fewest days left; undated after, in their own
      // order), lists (Shopping) last: a list is not work to chase. Urgent
      // cards stay above the fold (§3 invariant 4) however many projects
      // there are, and Overview reads like the Timeline: late first.
      ...signals.projects
        .filter((p) => !p.parent_id)
        .toSorted(
          (a, b) =>
            Number(a.kind === "list") - Number(b.kind === "list") ||
            (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER)
        )
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
