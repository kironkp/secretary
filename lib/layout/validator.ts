// The load-bearing validator (SPEC §3): every plan — planner, LLM, or chat —
// passes through here before it may render. Three passes: shape (JSON schema),
// props (per-registry), semantics (invariants 3–5, urgency, pins, preferences).
// Pure: no I/O, fully unit-tested (F5).
//
// Documented F5 choices:
// - Unknown component → that section is dropped (warning), the rest renders.
// - Two accents → auto-demoted to one: the accent on the soonest-deadline
//   project wins; ties keep the first. (Rejected-not-demoted was the
//   alternative; demotion degrades more gracefully mid-conversation.)
// - "Above the fold" = the first 8 sections of the plan.
import { PROP_SCHEMAS, isRegistryComponent, type RegistryComponent } from "./registry";
import { layoutPlanSchema, sectionKey, type LayoutPlan, type PlanSection } from "./plan";
import type { Signals } from "./signals";

export const ABOVE_THE_FOLD = 8;

export type LayoutPreference = {
  kind: "ban_component" | "pin_section" | "default_variant_for" | "accent_policy";
  value: Record<string, string>;
};

export type ValidationContext = {
  signals: Signals;
  /** Last known-good plan; first fallback candidate and the pin baseline. */
  previousPlan: LayoutPlan | null;
  preferences: LayoutPreference[];
  /** Section keys pinned by the user (kept position + variant). */
  pinnedSections: string[];
  defaultPlan: LayoutPlan;
  /** User-initiated changes are exempt from movement rationing (invariant 3). */
  userInitiated?: boolean;
  /** Names of approved dynamic components (SPEC v1.3) — valid section names. */
  dynamicComponents?: string[];
};

/** Longest common subsequence of two key arrays — sections outside it "moved". */
function lcs(a: string[], b: string[]): Set<string> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const keep = new Set<string>();
  let i = a.length,
    j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      keep.add(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return keep;
}

export type ValidationResult =
  | { ok: true; plan: LayoutPlan; warnings: string[] }
  | { ok: false; reasons: string[]; fallback: LayoutPlan };

const bannedComponents = (prefs: LayoutPreference[]) =>
  new Set(prefs.filter((p) => p.kind === "ban_component").map((p) => p.value.component));

/** Strip banned components out of a fallback plan so a fallback can't reintroduce them. */
export function applyBans(plan: LayoutPlan, prefs: LayoutPreference[]): LayoutPlan {
  const banned = bannedComponents(prefs);
  if (!banned.size) return plan;
  const sections = plan.sections.filter((s) => !banned.has(s.component));
  return sections.length ? { ...plan, sections } : plan;
}

export function validatePlan(input: unknown, ctx: ValidationContext): ValidationResult {
  const warnings: string[] = [];
  const fallback = () =>
    applyBans(ctx.previousPlan ?? ctx.defaultPlan, ctx.preferences);

  // Pass 1 — shape. Prose/markdown instead of JSON → fallback, never a throw.
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, reasons: ["not JSON"], fallback: fallback() };
    }
  }
  const parsed = layoutPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      fallback: fallback(),
    };
  }

  // Pass 2 — registry membership + per-component props.
  const sections: PlanSection[] = [];
  for (const s of parsed.data.sections) {
    if (!isRegistryComponent(s.component)) {
      // Approved dynamic components (SPEC v1.3) are valid; props free-form
      // (their output is interpolated + sanitized, never executed).
      if (ctx.dynamicComponents?.includes(s.component)) {
        sections.push({ component: s.component, props: s.props, why: s.why });
        continue;
      }
      warnings.push(`dropped unknown component "${s.component}"`);
      continue;
    }
    const component = s.component as RegistryComponent;
    const props = PROP_SCHEMAS[component].safeParse(s.props ?? {});
    if (!props.success) {
      if (component === "project_card") {
        // A project card without a valid subject renders nothing meaningful.
        warnings.push(`dropped project_card with invalid props`);
        continue;
      }
      warnings.push(`reset invalid props on "${component}" to defaults`);
      sections.push({ component, why: s.why });
      continue;
    }
    sections.push({ component, props: props.data as Record<string, unknown>, why: s.why });
  }
  if (!sections.length) {
    return { ok: false, reasons: ["no valid sections left"], fallback: fallback() };
  }
  // focus_banner is top-of-canvas only (SPEC §2).
  for (let i = sections.length - 1; i > 0; i--) {
    if (sections[i].component === "focus_banner") {
      warnings.push("dropped focus_banner not at top");
      sections.splice(i, 1);
    }
  }

  const plan: LayoutPlan = {
    plan_id: parsed.data.plan_id,
    reason_summary: parsed.data.reason_summary ?? null,
    sections,
    ...(parsed.data.wishlist ? { wishlist: parsed.data.wishlist } : {}),
  };

  // Pass 3 — semantics.
  const reasons: string[] = [];

  // Preferences: banned component present → plan rejected (F7).
  const banned = bannedComponents(ctx.preferences);
  for (const s of plan.sections) {
    if (banned.has(s.component)) reasons.push(`contains banned component "${s.component}"`);
  }

  // accent_policy: never → strip accents (preference coercion, not rejection).
  if (ctx.preferences.some((p) => p.kind === "accent_policy" && p.value.policy === "never")) {
    for (const s of plan.sections) {
      if (s.component === "project_card" && s.props?.accent) {
        s.props = { ...s.props, accent: false };
        warnings.push("accent removed (accent_policy: never)");
      }
    }
  }

  // Invariant 5 — at most one accent: auto-demote extras (soonest deadline wins).
  const accented = plan.sections.filter(
    (s) => s.component === "project_card" && s.props?.accent === true
  );
  if (accented.length > 1) {
    const daysLeft = (s: PlanSection) => {
      const p = ctx.signals.projects.find((x) => x.id === s.props?.project_id);
      return p?.days_left ?? Number.MAX_SAFE_INTEGER;
    };
    const keep = accented.toSorted((a, b) => daysLeft(a) - daysLeft(b))[0];
    for (const s of accented) {
      if (s !== keep) {
        s.props = { ...s.props, accent: false };
        warnings.push(`demoted extra accent on ${sectionKey(s)}`);
      }
    }
  }

  // Invariant 4 — nothing urgent disappears: every project with days_left <= 7
  // must have its card above the fold. Compact allowed; absent = rejected.
  for (const p of ctx.signals.projects) {
    if (p.days_left !== null && p.days_left <= 7) {
      const idx = plan.sections.findIndex(
        (s) => s.component === "project_card" && s.props?.project_id === p.id
      );
      if (idx === -1 || idx >= ABOVE_THE_FOLD) {
        reasons.push(`urgent project "${p.name}" (${p.days_left}d) not above the fold`);
      }
    }
  }

  // Invariant 3 — movement is rationed for SYSTEM-initiated plans: reordering
  // needs days_since_layout_change >= 1 AND a why on every moved section.
  // (User-initiated changes are exempt — nothing the user asked for is a surprise.)
  if (!ctx.userInitiated && ctx.previousPlan) {
    const prevKeys = ctx.previousPlan.sections.map(sectionKey);
    const newKeys = plan.sections.map(sectionKey);
    // Invariant 8: same-day system plans may add or re-emphasize, but
    // removals wait — a section the user saw today can't silently vanish.
    if (ctx.signals.context.days_since_layout_change < 1) {
      for (const key of prevKeys) {
        if (!newKeys.includes(key)) {
          reasons.push(`removal is rationed today: "${key}" would vanish`);
        }
      }
    }
    const common = new Set(prevKeys.filter((k) => newKeys.includes(k)));
    const prevSeq = prevKeys.filter((k) => common.has(k));
    const newSeq = newKeys.filter((k) => common.has(k));
    if (prevSeq.join("|") !== newSeq.join("|")) {
      if (ctx.signals.context.days_since_layout_change < 1) {
        reasons.push("reordering is rationed: layout already changed today");
      } else {
        const kept = lcs(prevSeq, newSeq);
        for (const s of plan.sections) {
          const key = sectionKey(s);
          if (common.has(key) && !kept.has(key) && !s.why) {
            reasons.push(`moved section "${key}" has no why`);
          }
        }
      }
    }
  }

  // Invariant 7 — pinned sections keep position + variant vs the previous plan.
  if (ctx.previousPlan) {
    const pinKeys = new Set([
      ...ctx.pinnedSections,
      ...ctx.preferences.filter((p) => p.kind === "pin_section").map((p) => p.value.section),
    ]);
    for (const key of pinKeys) {
      const oldIdx = ctx.previousPlan.sections.findIndex((s) => sectionKey(s) === key);
      if (oldIdx === -1) continue;
      const newIdx = plan.sections.findIndex((s) => sectionKey(s) === key);
      const oldVariant = ctx.previousPlan.sections[oldIdx].props?.variant;
      const newVariant = newIdx === -1 ? undefined : plan.sections[newIdx].props?.variant;
      if (newIdx !== oldIdx || (oldVariant !== undefined && newVariant !== oldVariant)) {
        reasons.push(`pinned section "${key}" moved or changed`);
      }
    }
  }

  if (reasons.length) return { ok: false, reasons, fallback: fallback() };
  return { ok: true, plan, warnings };
}
