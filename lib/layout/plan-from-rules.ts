// Planner v1 (SPEC §5): pure rules over Signals. Starts from DEFAULT_PLAN and
// applies rules in order; later rules may not violate earlier ones. Every
// deviation carries a user-addressed `why` naming the signal.
import { REGISTRY_VERSION } from "./registry";
import { defaultPlan, type LayoutPlan, type PlanSection } from "./plan";
import {
  isStrongEngagement,
  isStrongScheduleTalk,
  signalsHash,
  type Signals,
} from "./signals";

export function resolvePlan(
  signals: Signals,
  planner: (s: Signals) => LayoutPlan = planFromRules
): LayoutPlan {
  // Invariant 7: calm mode renders DEFAULT_PLAN unconditionally — the planner
  // is not even called (F6 asserts this via a spy).
  if (signals.context.calm_mode) return defaultPlan(signals);
  return planner(signals);
}

/**
 * Calendar days, in the user's zone, to the date that makes a project
 * pressing: the count the date beside the chip uses (lib/due.ts). days_left
 * counts whole 24-hour periods, so at 7 PM a task due tomorrow at 5 PM is
 * "0 days" by it, and the chip said "Due in 0 days" beside "tomorrow".
 * A committed deadline is the project's own date; otherwise the nearest date
 * that is not already past; and for a fixture or an event with neither,
 * days_left as before.
 */
function calendarDays(p: Signals["projects"][number]): number {
  if (p.deadline_type === "committed" && typeof p.deadline_days === "number") return p.deadline_days;
  const ahead = [p.soonest_days, p.deadline_days].filter((d): d is number => typeof d === "number" && d >= 0);
  return ahead.length ? Math.min(...ahead) : (p.days_left ?? 0);
}
const dueWords = (days: number): string => (days <= 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`);

export function planFromRules(signals: Signals): LayoutPlan {
  const base = defaultPlan(signals);
  const plan: LayoutPlan = structuredClone(base);
  const canReorder = signals.context.days_since_layout_change >= 1;
  const firedRules: string[] = [];
  let reordered = false;

  const cardOf = (projectId: string): PlanSection | undefined =>
    plan.sections.find(
      (s) => s.component === "project_card" && s.props?.project_id === projectId
    );

  // Rule 1 — deadline pressure. Accent only the soonest qualifier.
  const qualifying = signals.projects
    .filter(
      (p) =>
        p.days_left !== null &&
        (p.days_left <= 3 || (p.deadline_type === "committed" && p.days_left <= 7))
    )
    .toSorted((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));
  const deadlineAccented = qualifying[0] ?? null;
  if (deadlineAccented) {
    const card = cardOf(deadlineAccented.id);
    if (card) {
      card.props = { ...card.props, variant: "full", accent: true, inline_loops: true };
      card.why = `${dueWords(calendarDays(deadlineAccented))}${
        deadlineAccented.deadline_type === "committed" ? " — you committed to this date" : ""
      }`;
    }
    firedRules.push(`${deadlineAccented.name} due in ${deadlineAccented.days_left}d`);
  }

  // Rule 2 — engagement. Deadline accent wins when both fire.
  const engaged = signals.projects
    .filter((p) => signals.engagement[p.id] && isStrongEngagement(signals.engagement[p.id]))
    .toSorted((a, b) => {
      const ratio = (p: (typeof signals.projects)[number]) => {
        const e = signals.engagement[p.id];
        return e.mentions_24h / e.baseline_mentions;
      };
      return ratio(b) - ratio(a);
    })[0];
  if (engaged) {
    const e = signals.engagement[engaged.id];
    const card = cardOf(engaged.id);
    if (card) {
      const isAlsoDeadlineAccent = deadlineAccented?.id === engaged.id;
      card.props = {
        ...card.props,
        variant: "full",
        inline_loops: true,
        accent: isAlsoDeadlineAccent ? true : !deadlineAccented,
      };
      card.why = `${e.mentions_24h} mentions today vs ${e.baseline_mentions} typical`;
      // No move (v1.02): until then the card went to the top after a day.
      // The system never places a card (SPEC §2, composition); the accent,
      // the unfolded items and the why are how it says "this is the one".
    }
    firedRules.push(`${engaged.name} dominating the conversation`);
  }

  // Rule 3 — schedule-talk.
  if (isStrongScheduleTalk(signals.conversation)) {
    const timeline = plan.sections.find((s) => s.component === "timeline");
    if (timeline) {
      timeline.props = { span_days: 14, expanded: true };
      timeline.why = "You've been talking dates all day — the two weeks ahead, opened up";
      if (canReorder) {
        plan.sections.splice(plan.sections.indexOf(timeline), 1);
        plan.sections.unshift(timeline);
        reordered = true;
      }
      for (const s of plan.sections) {
        if (s.component === "project_card" && s.props?.accent !== true) {
          s.props = { ...s.props, variant: "compact" };
        }
      }
    }
    firedRules.push("schedule questions all day");
  }

  // Rule 4 — structure: >= 2 subprojects → nested (accented card keeps rule 1's
  // variant). Signals don't carry per-subproject deadlines yet, so the wishlist
  // half of this rule waits for that field (see INTEGRATION signals gaps).
  let nestedAny = false;
  for (const p of signals.projects) {
    if (p.subprojects.length >= 2) {
      const card = cardOf(p.id);
      if (card && card.props?.accent !== true) {
        card.props = { ...card.props, variant: "nested" };
        card.why ??= `${p.subprojects.length} tracks inside — shown as one card`;
        nestedAny = true;
      }
    }
  }
  if (nestedAny) firedRules.push("nested structure");

  // Rule 5 — nothing fired: DEFAULT_PLAN verbatim.
  if (!firedRules.length) return base;

  plan.plan_id = `rules-${signalsHash(signals, REGISTRY_VERSION)}`;
  plan.reason_summary =
    firedRules.length >= 2 || reordered ? firedRules.slice(0, 2).join("; ").slice(0, 120) : null;
  return plan;
}
