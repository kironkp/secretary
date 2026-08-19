// F5 validator unit tests (SPEC §8) + the F7 ban-preference validator half.
import { describe, expect, it } from "vitest";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { planFromRules } from "@/lib/layout/plan-from-rules";
import { validatePlan, type ValidationContext } from "@/lib/layout/validator";
import { baseSignals } from "./fixtures/layout";

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const signals = overrides.signals ?? baseSignals();
  return {
    signals,
    previousPlan: null,
    preferences: [],
    pinnedSections: [],
    defaultPlan: defaultPlan(signals),
    ...overrides,
  };
}

describe("F5 validator-rejects", () => {
  it("drops an unknown component, renders the rest, logs the reason", () => {
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    const withUnknown = {
      ...plan,
      sections: [{ component: "burndown_chart" }, ...plan.sections],
    };
    const res = validatePlan(withUnknown, ctx({ signals }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.sections.map((s) => s.component)).not.toContain("burndown_chart");
      expect(res.plan.sections.length).toBe(plan.sections.length);
      expect(res.warnings.join(" ")).toContain("burndown_chart");
    }
  });

  it("rejects a plan that omits the urgent patent card (days_left 3) and falls back", () => {
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    const withoutPatent: LayoutPlan = {
      ...plan,
      sections: plan.sections.filter((s) => sectionKey(s) !== "project_card:patent"),
    };
    const res = validatePlan(withoutPatent, ctx({ signals }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasons.join(" ")).toMatch(/patent/);
      expect(
        res.fallback.sections.some((s) => sectionKey(s) === "project_card:patent")
      ).toBe(true);
    }
  });

  it("auto-demotes a second accent to keep exactly one (documented choice)", () => {
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    for (const s of plan.sections) {
      if (s.component === "project_card" && ["patent", "album"].includes(String(s.props?.project_id))) {
        s.props = { ...s.props, accent: true };
      }
    }
    const res = validatePlan(plan, ctx({ signals }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const accents = res.plan.sections.filter(
        (s) => s.component === "project_card" && s.props?.accent === true
      );
      expect(accents).toHaveLength(1);
      // soonest deadline (patent, 3d) keeps the accent
      expect(accents[0].props?.project_id).toBe("patent");
    }
  });

  it("prose instead of JSON → fallback, no throw", () => {
    const res = validatePlan("Here's a nice layout for you!\n- timeline first", ctx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fallback.sections.length).toBeGreaterThan(0);
  });

  it("rejects a plan that moves a pinned section", () => {
    const signals = baseSignals();
    const previous = planFromRules(signals);
    const moved = structuredClone(previous);
    const [first] = moved.sections.splice(0, 1);
    moved.sections.push(first);
    const res = validatePlan(moved, ctx({
      signals,
      previousPlan: previous,
      pinnedSections: [sectionKey(previous.sections[0])],
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toContain("pinned");
  });
});

describe("invariant 3: movement rationing (system-initiated)", () => {
  it("rejects a system reorder when the layout already changed today", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const previous = planFromRules(signals);
    const moved = structuredClone(previous);
    const [first] = moved.sections.splice(0, 1);
    moved.sections.push(first);
    const res = validatePlan(moved, ctx({ signals, previousPlan: previous }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toContain("rationed");
  });

  it("rejects a permitted reorder whose moved section has no why", () => {
    const signals = baseSignals(); // days_since_layout_change: 2 — reorder allowed
    const previous = planFromRules(signals);
    const moved = structuredClone(previous);
    const idx = moved.sections.findIndex((s) => s.component === "date_chase");
    const [s] = moved.sections.splice(idx, 1);
    delete s.why;
    moved.sections.unshift(s);
    const res = validatePlan(moved, ctx({ signals, previousPlan: previous }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toContain("no why");
  });

  it("rejects a same-day system plan that REMOVES a section (invariant 8: removals wait)", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const previous = planFromRules(signals);
    const removed = structuredClone(previous);
    removed.sections = removed.sections.filter((s) => s.component !== "date_chase");
    const res = validatePlan(removed, ctx({ signals, previousPlan: previous }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toContain("removal is rationed");
  });

  it("lets the same reorder through when user-initiated", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const previous = planFromRules(signals);
    const moved = structuredClone(previous);
    const [first] = moved.sections.splice(0, 1);
    moved.sections.push(first);
    const res = validatePlan(moved, ctx({ signals, previousPlan: previous, userInitiated: true }));
    expect(res.ok).toBe(true);
  });
});

describe("why hygiene: whys only on deviations", () => {
  it("strips model self-talk whys from unchanged sections, keeps deviation whys", () => {
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    plan.sections[0].why = "No next hard commitment in SIGNALS."; // unchanged hero — meta note
    const timeline = plan.sections.find((s) => s.component === "timeline")!;
    timeline.props = { span_days: 14, expanded: true }; // real deviation
    timeline.why = "You've been asking about dates all day";
    const res = validatePlan(plan, ctx({ signals }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.sections[0].why).toBeUndefined();
      expect(res.plan.sections.find((s) => s.component === "timeline")?.why).toContain("dates");
      expect(res.warnings.join(" ")).toContain("stripped why");
    }
  });
});

describe("F7 (validator half): ban_component preference", () => {
  it("rejects any plan containing a banned component, and the fallback omits it too", () => {
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    const res = validatePlan(plan, ctx({
      signals,
      preferences: [{ kind: "ban_component", value: { component: "people_index" } }],
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reasons.join(" ")).toContain("people_index");
      expect(res.fallback.sections.map((s) => s.component)).not.toContain("people_index");
    }
  });
});
