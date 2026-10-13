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
// - Invariant 4 has no fixed position (v1.02; it was "the first 8 sections"):
//   an urgent project always has a card. Where cards sit is not checked here:
//   the system never places one (lib/layout/compose.ts), so there is nothing
//   to refuse.
// - Movement (invariant 3) is measured on the sections that are not cards and
//   that the user has not pinned: a card moving with the data is not a system
//   move, and a pin is applied by the composition, not checked.
import { PROP_SCHEMAS, RETIRED_COMPONENTS, isRegistryComponent, type RegistryComponent } from "./registry";
import { placedKeys } from "./compose";
import { isUrgent, layoutPlanSchema, sectionKey, urgencyLabel, type LayoutPlan, type PlanSection } from "./plan";
import type { Signals } from "./signals";

export type LayoutPreference = {
  /** hide_section: { section } — the user said "hide Z"; that one section stays off the board until they show it. */
  kind: "ban_component" | "pin_section" | "default_variant_for" | "accent_policy" | "hide_section";
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
  /**
   * Leave movement (invariants 3 and 8) out: the caller measures it itself on
   * the COMPOSED plan (movementReasons), after the user's pins are applied.
   */
  skipMovement?: boolean;
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

/**
 * A plan without the components he banned. The rules plan and the held one
 * are read through this before they are judged (SPEC §2): a ban is his, and
 * must not get the system's own plan refused. A planner's plan is still
 * refused for carrying one (F7).
 */
export function withoutBanned(plan: LayoutPlan, prefs: LayoutPreference[]): LayoutPlan {
  const banned = bannedComponents(prefs);
  return banned.size ? { ...plan, sections: plan.sections.filter((s) => !banned.has(s.component)) } : plan;
}

/**
 * Strip banned components, and sections the user hid, out of a plan, so no
 * planner or fallback can bring them back.
 */
export function applyBans(plan: LayoutPlan, prefs: LayoutPreference[]): LayoutPlan {
  const banned = bannedComponents(prefs);
  const hidden = new Set(prefs.filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  if (!banned.size && !hidden.size) return plan;
  const sections = plan.sections.filter((s) => !banned.has(s.component) && !hidden.has(sectionKey(s)));
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
    sections.push({ component, props: props.data as Record<string, unknown>, why: s.why, ...(s.place !== undefined ? { place: s.place } : {}) });
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

  // A why belongs ONLY on a deviation. LLM planners like to annotate
  // unchanged sections with introspection ("No engagement stats provided…")
  // — that's model self-talk, not a user-facing reason. Strip why from any
  // section whose props match its DEFAULT_PLAN counterpart.
  for (const s of plan.sections) {
    if (!s.why) continue;
    const base = ctx.defaultPlan.sections.find((d) => sectionKey(d) === sectionKey(s));
    if (base && JSON.stringify(s.props ?? {}) === JSON.stringify(base.props ?? {})) {
      delete s.why;
      warnings.push(`stripped why on unchanged section "${sectionKey(s)}"`);
    }
  }

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

  // Invariant 4 — nothing urgent disappears (SPEC §3, v1.02). Urgent is late
  // open work or a date within the week (isUrgent); a list never is. An
  // urgent project always has a card: compact allowed, absent = rejected, for
  // a planner's plan and for a user's request to hide it alike. Where the
  // card sits is the composition's business, not this check's.
  const cards = plan.sections.filter((s) => s.component === "project_card").map((s) => String(s.props?.project_id ?? ""));
  for (const p of ctx.signals.projects.filter(isUrgent)) {
    if (!cards.includes(p.id)) reasons.push(`urgent project "${p.name}" (${urgencyLabel(p)}) would have no card`);
  }

  if (!ctx.userInitiated && !ctx.skipMovement) reasons.push(...movementReasons(plan, ctx));

  if (reasons.length) return { ok: false, reasons, fallback: fallback() };
  return { ok: true, plan, warnings };
}

/**
 * Invariants 3 and 8 — movement is rationed for SYSTEM-initiated plans:
 * reordering needs days_since_layout_change >= 1 AND a why on every moved
 * section, and same-day plans may not remove what the user saw today.
 *
 * The system is measured against the system (SPEC §2, v1.02 r5): only the
 * sections that were the system's on the stored board AND are the system's
 * now. Not the project cards, which follow the data; and not a section that
 * changes hands in either direction (he places it, lets it go, hides it,
 * shows it, bans it), so none of his own requests gets a plan refused or
 * held. `plan` is the COMPOSED board: what he placed carries its place. A
 * previous plan that is itself the default (nobody arranged it) is measured
 * as the NEW default (SEC-A007): a product change to the default is not the
 * planner moving things. A retired component's section is not on anyone's
 * screen, so its absence is not a removal.
 */
export function movementReasons(plan: LayoutPlan, ctx: ValidationContext): string[] {
  const reasons: string[] = [];
  const baseline = ctx.previousPlan?.plan_id === "default" ? ctx.defaultPlan : ctx.previousPlan;
  if (!baseline) return reasons;
  const hisThen = placedKeys(ctx.previousPlan, ctx.pinnedSections, ctx.preferences, ctx.signals);
  const hisNow = new Set(plan.sections.filter((s) => s.place !== undefined).map(sectionKey));
  const banned = bannedComponents(ctx.preferences);
  const hidden = new Set(ctx.preferences.filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  const systems = (s: PlanSection) => {
    const key = sectionKey(s);
    return s.component !== "project_card" && s.place === undefined && !hisThen.has(key) && !hisNow.has(key) && !hidden.has(key) && !banned.has(s.component);
  };
  const prevKeys = baseline.sections.filter((s) => !RETIRED_COMPONENTS.has(s.component) && systems(s)).map(sectionKey);
  const newKeys = plan.sections.filter(systems).map(sectionKey);
  // Invariant 8: same-day system plans may add or re-emphasize, but
  // removals wait — a section the user saw today can't silently vanish.
  if (ctx.signals.context.days_since_layout_change < 1) {
    for (const key of prevKeys) {
      if (!newKeys.includes(key)) reasons.push(`removal is rationed today: "${key}" would vanish`);
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
        if (common.has(key) && !kept.has(key) && !s.why) reasons.push(`moved section "${key}" has no why`);
      }
    }
  }
  return reasons;
}
