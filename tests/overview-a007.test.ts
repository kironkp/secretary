// SEC-A007, "a clear Overview": the default plan's new shape, and that it
// actually reaches a board nobody arranged (Kiron's is "default", no pins)
// while a board the user arranged keeps its order. Registry v3 retires
// open_loops (the WHAT/WHEN/HEARD table) and draws timeline as the projects
// progress strip; Needs a date's one-tap dates are his calendar days.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { REGISTRY_COMPONENTS, REGISTRY_VERSION, RETIRED_COMPONENTS } from "@/lib/layout/registry";
import { validatePlan, type ValidationContext } from "@/lib/layout/validator";
import type { Signals } from "@/lib/layout/signals";
import { datePresets, pickedDay } from "@/lib/timeline";
import { baseSignals } from "./fixtures/layout";

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const signals = overrides.signals ?? baseSignals();
  return { signals, previousPlan: null, preferences: [], pinnedSections: [], defaultPlan: defaultPlan(signals), ...overrides };
}
const keys = (p: LayoutPlan) => p.sections.map(sectionKey);

/** The default as it was before registry v3: cards, then the chart, then the table. */
function oldDefault(signals: Signals): LayoutPlan {
  return {
    plan_id: "default",
    reason_summary: null,
    sections: [
      { component: "hero_next_up" },
      { component: "stat_row" },
      ...signals.projects.map((p) => ({ component: "project_card", props: { project_id: p.id, variant: "full" } })),
      { component: "timeline", props: { span_days: 21, expanded: false } },
      { component: "open_loops", props: { group_by: "project", include_done: true } },
      { component: "date_chase" },
      { component: "people_index" },
    ],
  };
}

describe("registry v3", () => {
  it("retires open_loops and keeps timeline (now the progress strip)", () => {
    expect(REGISTRY_VERSION).toBe(3);
    expect(REGISTRY_COMPONENTS).not.toContain("open_loops");
    expect(REGISTRY_COMPONENTS).toContain("timeline");
    expect(RETIRED_COMPONENTS.has("open_loops")).toBe(true);
  });

  it("a plan that still names open_loops renders without it", () => {
    const res = validatePlan(oldDefault(baseSignals()), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.sections.map((s) => s.component)).not.toContain("open_loops");
    expect(res.warnings).toContain('dropped unknown component "open_loops"');
  });
});

describe("DEFAULT_PLAN, top to bottom", () => {
  it("next up, the tiles, the progress strip, the project cards most urgent first, Needs a date; no table", () => {
    expect(keys(defaultPlan(baseSignals()))).toEqual([
      "hero_next_up",
      "stat_row",
      "timeline",
      "project_card:patent", // 3 days left
      "project_card:album", // 11
      "project_card:findit", // 31
      "project_card:caltrans", // no date: after the dated ones
      "date_chase",
      "people_index",
    ]);
  });

  it("lists (Shopping) come after every project, wherever they were made", () => {
    const signals = baseSignals();
    signals.projects.unshift({ ...signals.projects[3], id: "shopping", name: "Shopping", kind: "list" });
    const cards = keys(defaultPlan(signals)).filter((k) => k.startsWith("project_card:"));
    expect(cards.at(-1)).toBe("project_card:shopping");
  });

  it("a board of ten cards (nine projects and a list, like Kiron's) is a valid plan", () => {
    const signals = baseSignals();
    for (let i = 0; i < 5; i++) signals.projects.push({ ...signals.projects[3], id: `p-${i}`, name: `p ${i}` });
    signals.projects.push({ ...signals.projects[3], id: "shopping", name: "Shopping", kind: "list" });
    expect(defaultPlan(signals).sections).toHaveLength(15);
    const res = validatePlan(defaultPlan(signals), ctx({ signals }));
    expect(res.ok ? "ok" : res.reasons).toBe("ok");
  });

  it("an urgent project made last still has its card above the fold, among nine", () => {
    const signals = baseSignals();
    for (let i = 0; i < 5; i++) {
      signals.projects.push({ ...signals.projects[3], id: `quiet-${i}`, name: `quiet ${i}` });
    }
    signals.projects.push({ ...signals.projects[0], id: "late-one", name: "late one", days_left: -2 });
    const res = validatePlan(defaultPlan(signals), ctx({ signals }));
    expect(res.ok).toBe(true);
    expect(keys(defaultPlan(signals))[3]).toBe("project_card:late-one");
  });
});

describe("the new default reaches a board nobody arranged", () => {
  it("over the old default, the same day: accepted (no 'removal rationed', no 'moved without a why')", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const res = validatePlan(defaultPlan(signals), ctx({ signals, previousPlan: oldDefault(signals) }));
    expect(res.ok ? "ok" : res.reasons).toBe("ok");
  });

  it("over the old default, days later: accepted too", () => {
    const signals = baseSignals();
    const res = validatePlan(defaultPlan(signals), ctx({ signals, previousPlan: oldDefault(signals) }));
    expect(res.ok ? "ok" : res.reasons).toBe("ok");
  });

  it("a rules plan over the old default (an accent) is accepted as well", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const plan = defaultPlan(signals);
    plan.plan_id = "rules-x";
    plan.sections[3] = { ...plan.sections[3], props: { ...plan.sections[3].props, accent: true }, why: "Due in 3 days" };
    const res = validatePlan(plan, ctx({ signals, previousPlan: oldDefault(signals) }));
    expect(res.ok ? "ok" : res.reasons).toBe("ok");
  });
});

describe("a board the user arranged keeps its order", () => {
  /** Arranged by the user: the album first, the table pinned where it was. */
  function arranged(signals: Signals): LayoutPlan {
    const old = oldDefault(signals);
    const album = old.sections.find((s) => s.props?.project_id === "album")!;
    return { ...old, plan_id: "user-abc", sections: [album, ...old.sections.filter((s) => s !== album)] };
  }

  it("the planner may not reorder it: the new default is refused against it", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const res = validatePlan(defaultPlan(signals), ctx({ signals, previousPlan: arranged(signals) }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reasons.join(" ")).toMatch(/reordering is rationed/);
  });

  it("but the retired table leaving it is not a removal, and a pin on it blocks nothing", () => {
    const signals = baseSignals();
    signals.context.days_since_layout_change = 0;
    const prev = arranged(signals);
    const same = { ...prev, plan_id: "rules-y", sections: prev.sections.filter((s) => s.component !== "open_loops") };
    const res = validatePlan(same, ctx({ signals, previousPlan: prev, pinnedSections: ["open_loops", "project_card:album", "date_chase"] }));
    expect(res.ok ? "ok" : res.reasons).toBe("ok");
  });

  it("a pinned section that really moved is still refused", () => {
    const signals = baseSignals();
    const prev = arranged(signals);
    const shown = prev.sections.filter((s) => s.component !== "open_loops");
    const moved = { ...prev, plan_id: "rules-z", sections: [shown[1], shown[0], ...shown.slice(2)].map((s) => ({ ...s, why: "x" })) };
    const res = validatePlan(moved, ctx({ signals, previousPlan: prev, pinnedSections: ["project_card:album"] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reasons.join(" ")).toMatch(/pinned section "project_card:album" moved/);
  });
});

describe("Needs a date: Today, Tomorrow, Next week, Pick…, at 5 PM on his calendar days", () => {
  const LA = "America/Los_Angeles";
  it("from a Tuesday at noon in Los Angeles", () => {
    const now = new Date("2026-10-06T19:00:00Z"); // Tue Oct 6, 12:00 PDT
    expect(datePresets(LA, now)).toEqual({
      today: "2026-10-07T00:00:00.000Z", // Tue 5 PM PDT
      tomorrow: "2026-10-08T00:00:00.000Z",
      nextWeek: "2026-10-13T00:00:00.000Z", // Mon Oct 12
    });
  });
  it("late in the evening it is still his today, not UTC's tomorrow", () => {
    const now = new Date("2026-10-07T05:30:00Z"); // Tue Oct 6, 22:30 PDT
    expect(datePresets(LA, now).today).toBe("2026-10-07T00:00:00.000Z");
  });
  it("from a Monday, next week is a week on; from a Sunday, it is tomorrow", () => {
    expect(datePresets(LA, new Date("2026-10-12T19:00:00Z")).nextWeek).toBe("2026-10-20T00:00:00.000Z");
    expect(datePresets(LA, new Date("2026-10-11T19:00:00Z")).nextWeek).toBe("2026-10-13T00:00:00.000Z");
  });
  it("a picked day keeps 5 PM across the end of daylight time", () => {
    expect(pickedDay("2026-10-20", LA)).toBe("2026-10-21T00:00:00.000Z");
    expect(pickedDay("2026-11-05", LA)).toBe("2026-11-06T01:00:00.000Z");
    expect(pickedDay("not a date", LA)).toBeNull();
  });
});
