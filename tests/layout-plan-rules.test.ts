// Golden fixtures F1–F4, F6 (SPEC §8) over planFromRules + resolvePlan.
import { describe, expect, it, vi } from "vitest";
import { defaultPlan, sectionKey, sectionOrder, type LayoutPlan } from "@/lib/layout/plan";
import { planFromRules, resolvePlan } from "@/lib/layout/plan-from-rules";
import { baseSignals } from "./fixtures/layout";

const cardFor = (plan: LayoutPlan, projectId: string) =>
  plan.sections.find((s) => s.component === "project_card" && s.props?.project_id === projectId);
const accents = (plan: LayoutPlan) =>
  plan.sections.filter((s) => s.component === "project_card" && s.props?.accent === true);

// The shared base has patent at days_left 3, which fires deadline rule 1 in
// every fixture — F1's "quiet day" quiets it by pushing patent out to 20 days.
function quietBase() {
  const s = baseSignals();
  const patent = s.projects.find((p) => p.id === "patent")!;
  patent.deadline = "2026-08-27";
  patent.days_left = 20;
  return s;
}

describe("F1 quiet-day", () => {
  it("emits DEFAULT_PLAN verbatim: null reason, zero whys, zero wishlist", () => {
    const signals = quietBase();
    const plan = planFromRules(signals);
    expect(plan).toEqual(defaultPlan(signals));
    expect(plan.reason_summary).toBeNull();
    expect(plan.sections.every((s) => s.why === undefined)).toBe(true);
    expect(plan.wishlist ?? []).toEqual([]);
  });
});

describe("F2 timeline-day", () => {
  const signals = baseSignals();
  signals.conversation.schedule_word_share = 0.42;
  signals.conversation.questions_today = [
    "when is the album due?",
    "what date is the patent filing?",
    "can we schedule findit for September?",
  ];
  const plan = planFromRules(signals);

  it("puts the expanded 14-day timeline first, with a why", () => {
    expect(plan.sections[0].component).toBe("timeline");
    expect(plan.sections[0].props).toMatchObject({ expanded: true, span_days: 14 });
    expect(plan.sections[0].why).toBeTruthy();
  });
  it("keeps patent above the fold with its accent (rule 1 beats rule 3)", () => {
    const idx = plan.sections.findIndex(
      (s) => s.component === "project_card" && s.props?.project_id === "patent"
    );
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(8);
    expect(cardFor(plan, "patent")?.props).toMatchObject({ accent: true, variant: "full" });
  });
  it("compacts the non-accented cards", () => {
    for (const id of ["album", "findit", "caltrans"]) {
      expect(cardFor(plan, id)?.props).toMatchObject({ variant: "compact" });
    }
  });
});

describe("F3a engagement-promote", () => {
  const signals = baseSignals();
  signals.engagement.patent = {
    mentions_24h: 14,
    baseline_mentions: 2,
    last_touched: "2026-08-07T08:30:00Z",
  };
  const plan = planFromRules(signals);

  it("accents patent full with inline loops, right after the hero", () => {
    const heroIdx = plan.sections.findIndex((s) => s.component === "hero_next_up");
    const card = plan.sections[heroIdx + 1];
    expect(sectionKey(card)).toBe("project_card:patent");
    expect(card.props).toMatchObject({ accent: true, variant: "full", inline_loops: true });
  });
  it("says why, naming both numbers, and keeps exactly one accent", () => {
    const card = cardFor(plan, "patent")!;
    expect(card.why).toContain("14");
    expect(card.why).toContain("2");
    expect(accents(plan)).toHaveLength(1);
  });
});

describe("F3b engagement-no-reorder", () => {
  const signals = baseSignals();
  signals.engagement.patent = {
    mentions_24h: 14,
    baseline_mentions: 2,
    last_touched: "2026-08-07T08:30:00Z",
  };
  signals.context.days_since_layout_change = 0;
  const plan = planFromRules(signals);

  it("emphasis lands but section order deep-equals DEFAULT_PLAN order", () => {
    expect(cardFor(plan, "patent")?.props).toMatchObject({
      accent: true,
      variant: "full",
      inline_loops: true,
    });
    expect(sectionOrder(plan)).toBe(sectionOrder(defaultPlan(signals)));
  });
});

describe("F4 nested-structure", () => {
  const signals = baseSignals();
  signals.projects.find((p) => p.id === "album")!.subprojects = [
    { id: "alb-1", name: "tracking", open_count: 3, done_count: 1 },
    { id: "alb-2", name: "mixing", open_count: 2, done_count: 0 },
    { id: "alb-3", name: "art", open_count: 1, done_count: 0 },
    { id: "alb-4", name: "release", open_count: 2, done_count: 0 },
  ];
  const plan = planFromRules(signals);

  it("renders album nested without accent; accent stays on patent (days_left 3)", () => {
    expect(cardFor(plan, "album")?.props).toMatchObject({ variant: "nested" });
    expect(cardFor(plan, "album")?.props?.accent ?? false).toBe(false);
    expect(cardFor(plan, "patent")?.props).toMatchObject({ accent: true });
    expect(accents(plan)).toHaveLength(1);
  });
});

describe("F6 calm-mode", () => {
  it("returns DEFAULT_PLAN verbatim and never calls the planner", () => {
    const signals = baseSignals();
    signals.context.calm_mode = true;
    // strong signals everywhere:
    signals.engagement.patent = {
      mentions_24h: 20,
      baseline_mentions: 2,
      last_touched: "2026-08-07T08:30:00Z",
    };
    signals.conversation.schedule_word_share = 0.9;
    const planner = vi.fn(planFromRules);
    const plan = resolvePlan(signals, planner);
    expect(plan).toEqual(defaultPlan(signals));
    expect(planner).not.toHaveBeenCalled();
  });
});
