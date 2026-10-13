// SPEC §3 invariant 4, "nothing urgent disappears", as revised in v1.02: an
// urgent project always has a card (presence), and the SYSTEM does not move a
// card that is not urgent ahead of one that is (order), judged on what it
// changed. No fixed position: the old rule, "above the fold", could not be
// met with six late projects, so the default and the rules plan were refused
// and so was every request the user made. Pure: the validator, the default,
// the rules planner, the fallback chain and the repair, on made-up boards.
process.env.TZ = "UTC";

import { beforeEach, describe, expect, it } from "vitest";
import { defaultPlan, isUrgent, sectionKey, withUrgentCards, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { planFromRules } from "@/lib/layout/plan-from-rules";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import { validatePlan, type ValidationContext } from "@/lib/layout/validator";
import type { ProjectSignal, Signals } from "@/lib/layout/signals";
import { baseSignals } from "./fixtures/layout";

/** One made-up project: `soonest` is days to its earliest open task (negative = late). */
function project(name: string, soonest: number | null, kind: "project" | "list" = "project"): ProjectSignal {
  return {
    ...baseSignals().projects[3],
    id: name.toLowerCase().replace(/ /g, "-"),
    name,
    kind,
    days_left: soonest !== null && soonest >= 0 ? soonest : null,
    soonest_days: soonest,
    deadline_days: null,
  };
}
/** A board with `late` late projects, one due in three days, three quiet ones and a list. */
function board(late: number): Signals {
  const signals = baseSignals();
  signals.projects = [
    ...Array.from({ length: late }, (_, i) => project(`Late ${String.fromCharCode(65 + i)}`, -(i + 2))),
    project("Soon", 3),
    project("Quiet one", null),
    project("Quiet two", 40),
    project("Quiet three", null),
    project("Shopping", -30, "list"),
  ];
  signals.engagement = Object.fromEntries(
    signals.projects.map((p) => [p.id, { mentions_24h: 0, baseline_mentions: 2, last_touched: "2026-08-05T12:00:00Z" }])
  );
  return signals;
}
const ctx = (signals: Signals, over: Partial<ValidationContext> = {}): ValidationContext => ({
  signals,
  previousPlan: null,
  preferences: [],
  pinnedSections: [],
  defaultPlan: defaultPlan(signals),
  ...over,
});
const cards = (plan: LayoutPlan) => plan.sections.filter((s) => s.component === "project_card").map((s) => String(s.props?.project_id));
const card = (id: string): PlanSection => ({ component: "project_card", props: { project_id: id, variant: "full" } });
/** The plan with one card lifted out and put back just before another. */
function moveBefore(plan: LayoutPlan, id: string, before: string): LayoutPlan {
  const moved = plan.sections.find((s) => s.props?.project_id === id)!;
  const rest = plan.sections.filter((s) => s !== moved);
  const at = rest.findIndex((s) => s.props?.project_id === before);
  return { ...plan, plan_id: "moved", sections: [...rest.slice(0, at), moved, ...rest.slice(at)] };
}
const reasonsOf = (res: ReturnType<typeof validatePlan>) => (res.ok ? "ok" : res.reasons.join(" | "));
/** "Put the shopping list at the top": the list's card above every other card, as the user's own plan. */
const listOnTop = (signals: Signals): LayoutPlan => ({
  ...moveBefore(defaultPlan(signals), "shopping", cards(defaultPlan(signals))[0]),
  plan_id: "user-abc",
});

beforeEach(() => clearPlanCache());

describe("what counts as urgent", () => {
  it("late work, or a date within the week; a list never, however late its items", () => {
    expect(isUrgent(project("A", -1))).toBe(true);
    expect(isUrgent(project("B", 7))).toBe(true);
    expect(isUrgent(project("C", 8))).toBe(false);
    expect(isUrgent(project("D", null))).toBe(false);
    expect(isUrgent(project("Shopping", -30, "list"))).toBe(false);
  });
});

describe.each([5, 6, 9])("a board with %i late projects", (late) => {
  const signals = board(late);

  it("the default is valid, with every urgent card ahead of every card that is not", () => {
    const plan = defaultPlan(signals);
    expect(reasonsOf(validatePlan(plan, ctx(signals)))).toBe("ok");
    const ids = cards(plan);
    const urgentIds = signals.projects.filter(isUrgent).map((p) => p.id);
    expect(urgentIds).toHaveLength(late + 1);
    expect(ids.slice(0, late + 1).toSorted()).toEqual(urgentIds.toSorted());
    expect(ids.at(-1)).toBe("shopping");
  });

  it("the rules plan is valid, on a quiet day and on a day a quiet project is all the user talks about", () => {
    expect(reasonsOf(validatePlan(planFromRules(signals), ctx(signals)))).toBe("ok");
    const busy = board(late);
    busy.engagement["quiet-two"] = { mentions_24h: 14, baseline_mentions: 2, last_touched: "2026-08-07T08:00:00Z" };
    const plan = planFromRules(busy);
    expect(reasonsOf(validatePlan(plan, ctx(busy)))).toBe("ok");
    // It moved up, with its why, and stopped just below the urgent cards.
    const ids = cards(plan);
    expect(ids.indexOf("quiet-two")).toBe(late + 1);
    expect(plan.sections.find((s) => s.props?.project_id === "quiet-two")?.why).toMatch(/mentions today/);
  });

  it("a planner plan that puts a card that is not urgent ahead of an urgent one is refused, and still paid for", async () => {
    const bad = moveBefore(defaultPlan(signals), "quiet-one", "late-a");
    const direct = validatePlan(bad, ctx(signals));
    expect(reasonsOf(direct)).toMatch(/"Quiet one" is not urgent and would move ahead of urgent project "Late A" \(2d late\)/);

    const res = await planWithFallback(signals, {
      previousPlan: null,
      preferences: [],
      pinnedSections: [],
      llmEnabled: true,
      call: async () => JSON.stringify(bad),
    });
    expect(res.source).toBe("rules");
    expect(res.called).toBe(true);
    expect(cards(res.plan)).toEqual(cards(defaultPlan(signals)));
  });

  it("no fixed position: urgent cards far down the board, in order, are a valid plan", () => {
    const plan = defaultPlan(signals);
    const hero = plan.sections[0];
    const filler: PlanSection[] = Array.from({ length: 12 }, () => ({ component: "people_index" }));
    const pushedDown: LayoutPlan = { ...plan, plan_id: "rules-x", sections: [hero, ...filler, ...plan.sections.slice(1)] };
    expect(pushedDown.sections.findIndex((s) => s.props?.project_id === "soon")).toBeGreaterThan(8);
    expect(reasonsOf(validatePlan(pushedDown, ctx(signals)))).toBe("ok");
  });
});

describe("presence", () => {
  const signals = board(6);

  it("a system plan without an urgent project's card is rejected", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, sections: plan.sections.filter((s) => s.props?.project_id !== "late-c") };
    expect(reasonsOf(validatePlan(without, ctx(signals)))).toMatch(/urgent project "Late C" \(4d late\) would have no card/);
  });

  it("so is a change the user asked for that would leave one out (hiding an urgent card behaves as before)", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, plan_id: "user-x", sections: plan.sections.filter((s) => s.props?.project_id !== "soon") };
    expect(reasonsOf(validatePlan(without, ctx(signals, { previousPlan: plan, userInitiated: true })))).toMatch(/urgent project "Soon" \(3d\) would have no card/);
  });

  it("a list with late items is not urgent: a plan without its card is valid", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, sections: plan.sections.filter((s) => s.props?.project_id !== "shopping") };
    expect(reasonsOf(validatePlan(without, ctx(signals)))).toBe("ok");
  });
});

describe("order is judged on what the system changed", () => {
  const signals = board(6);
  signals.context.days_since_layout_change = 5;
  // The user's own board: the list on top, and a quiet project above the late ones.
  const arranged: LayoutPlan = moveBefore(moveBefore(defaultPlan(signals), "shopping", "late-a"), "quiet-three", "late-a");
  arranged.plan_id = "user-abc";

  it("the user's order is never refused for order, at five late projects or nine", () => {
    for (const late of [5, 6, 9]) {
      const s = board(late);
      expect(reasonsOf(validatePlan(listOnTop(s), ctx(s, { previousPlan: defaultPlan(s), userInitiated: true })))).toBe("ok");
    }
  });

  it("a system plan that keeps the pairs his board already has is accepted", () => {
    const sameOrder = { ...arranged, plan_id: "rules-x", sections: arranged.sections.map((s) => (s.props?.project_id === "late-a" ? { ...s, props: { ...s.props, variant: "compact" } } : s)) };
    expect(reasonsOf(validatePlan(sameOrder, ctx(signals, { previousPlan: arranged })))).toBe("ok");
  });

  it("but it may not add one: another quiet card moved above a late one is refused, why or no why", () => {
    const worse = moveBefore(arranged, "quiet-one", "late-b");
    for (const s of worse.sections) if (s.props?.project_id === "quiet-one") s.why = "You asked about it this morning";
    expect(reasonsOf(validatePlan({ ...worse, plan_id: "rules-y" }, ctx(signals, { previousPlan: arranged })))).toMatch(
      /"Quiet one" is not urgent and would move ahead of urgent project "Late B"/
    );
  });

  it("the system may not move a list ahead of an urgent project; the user may", () => {
    const listUp = moveBefore(defaultPlan(signals), "shopping", "soon");
    for (const s of listUp.sections) if (s.props?.project_id === "shopping") s.why = "You have been shopping all day";
    expect(reasonsOf(validatePlan({ ...listUp, plan_id: "rules-z" }, ctx(signals, { previousPlan: defaultPlan(signals) })))).toMatch(
      /"Shopping" is not urgent and would move ahead of urgent project "Soon"/
    );
    expect(reasonsOf(validatePlan({ ...listUp, plan_id: "user-z" }, ctx(signals, { previousPlan: defaultPlan(signals), userInitiated: true })))).toBe("ok");
  });

  it("with no plan to replace, any such pair is refused", () => {
    expect(reasonsOf(validatePlan({ ...arranged, plan_id: "rules-new" }, ctx(signals)))).toMatch(/is not urgent and would move ahead of urgent project/);
  });
});

describe("a board left as it stands is what renders", () => {
  it.each([5, 6, 9])("his arranged board with %i late projects survives a new situation the same day and days later", async (late) => {
    for (const days of [0, 3]) {
      const signals = board(late);
      signals.context.days_since_layout_change = days;
      const arranged = listOnTop(signals);
      const res = await planWithFallback(signals, { previousPlan: arranged, preferences: [], pinnedSections: ["project_card:shopping"], llmEnabled: false });
      expect(res.source).toBe("previous");
      expect(res.plan.sections.map(sectionKey)).toEqual(arranged.sections.map(sectionKey));
      expect(cards(res.plan)[0]).toBe("shopping");
    }
  });

  it("a planner answer may not undo his move: it is refused, paid for, and his board stands", async () => {
    const signals = board(6);
    signals.context.days_since_layout_change = 3;
    const arranged = listOnTop(signals);
    // The planner puts the list back at the bottom, with a why on everything.
    const undo = { ...defaultPlan(signals), plan_id: "x", sections: defaultPlan(signals).sections.map((s) => ({ ...s, why: "Tidier this way" })) };
    const res = await planWithFallback(signals, {
      previousPlan: arranged,
      preferences: [],
      pinnedSections: ["project_card:shopping"],
      llmEnabled: true,
      call: async () => JSON.stringify(undo),
    });
    expect(res.called).toBe(true);
    expect(res.source).toBe("previous");
    expect(res.plan.sections.map(sectionKey)).toEqual(arranged.sections.map(sectionKey));
    expect(cards(res.plan)[0]).toBe("shopping");
  });
});

describe("a stored plan that has come to lack an urgent card is repaired, not rejected", () => {
  const signals = board(5);
  const arranged = listOnTop(signals);
  const without = (id: string): LayoutPlan => ({ ...arranged, sections: arranged.sections.filter((s) => s.props?.project_id !== id) });

  it("the card is added after the last urgent card, with a why, and nothing else moves", () => {
    const stored = without("late-c");
    const repaired = withUrgentCards(stored, signals);
    const keys = repaired.sections.map(sectionKey);
    expect(keys.filter((k) => k === "project_card:late-c")).toHaveLength(1);
    // "Soon" is the last urgent card on his board; the new one sits right after it.
    expect(keys[keys.indexOf("project_card:soon") + 1]).toBe("project_card:late-c");
    expect(repaired.sections.find((s) => s.props?.project_id === "late-c")?.why).toBe("Back on your board: it has late work");
    expect(keys.filter((k) => k !== "project_card:late-c")).toEqual(stored.sections.map(sectionKey));
    // Once it is there, there is nothing to repair.
    expect(withUrgentCards(repaired, signals)).toBe(repaired);
  });

  it("a project due within the week says so; two missing cards go in urgency order", () => {
    const stored = { ...arranged, sections: arranged.sections.filter((s) => !["soon", "late-b"].includes(String(s.props?.project_id))) };
    const repaired = withUrgentCards(stored, signals);
    const ids = cards(repaired);
    const lastStanding = Math.max(...["late-a", "late-c", "late-d", "late-e"].map((id) => ids.indexOf(id)));
    expect(ids.slice(lastStanding + 1, lastStanding + 3)).toEqual(["late-b", "soon"]);
    expect(repaired.sections.find((s) => s.props?.project_id === "soon")?.why).toBe("Back on your board: it is due within a week");
  });

  it("with no urgent card on the board it goes at the end of the cards; with no cards, at the end", () => {
    const quiet: LayoutPlan = { plan_id: "user-q", reason_summary: null, sections: [{ component: "hero_next_up" }, card("quiet-one"), card("shopping"), { component: "date_chase" }] };
    const one = board(1);
    one.projects = one.projects.filter((p) => p.id !== "soon");
    expect(withUrgentCards(quiet, one).sections.map(sectionKey)).toEqual(["hero_next_up", "project_card:quiet-one", "project_card:shopping", "project_card:late-a", "date_chase"]);
    const bare: LayoutPlan = { plan_id: "user-b", reason_summary: null, sections: [{ component: "hero_next_up" }, { component: "date_chase" }] };
    expect(withUrgentCards(bare, one).sections.map(sectionKey)).toEqual(["hero_next_up", "date_chase", "project_card:late-a"]);
  });

  it("through the fallback chain: his arrangement survives a project going late, plus exactly one card", async () => {
    const stored = without("late-c");
    const res = await planWithFallback(signals, { previousPlan: stored, preferences: [], pinnedSections: ["project_card:shopping"], llmEnabled: false });
    expect(res.source).toBe("previous");
    const keys = res.plan.sections.map(sectionKey);
    expect(keys.filter((k) => k !== "project_card:late-c")).toEqual(stored.sections.map(sectionKey));
    expect(res.plan.sections.find((s) => s.props?.project_id === "late-c")?.why).toMatch(/late work/);
    // And the plan it has become is stable: kept again, the why still on it.
    const again = await planWithFallback(signals, { previousPlan: res.plan, preferences: [], pinnedSections: ["project_card:shopping"], llmEnabled: false });
    expect(again.plan.sections).toEqual(res.plan.sections);
  });

  it("a card he hid comes back while its project is late, and only that card", async () => {
    const hidden = [{ kind: "hide_section" as const, value: { section: "project_card:late-c", at: "5" } }];
    const stored = without("late-c");
    const res = await planWithFallback(signals, { previousPlan: stored, preferences: hidden, pinnedSections: [], llmEnabled: false });
    const keys = res.plan.sections.map(sectionKey);
    expect(keys.filter((k) => k === "project_card:late-c")).toHaveLength(1);
    expect(keys.filter((k) => k !== "project_card:late-c")).toEqual(stored.sections.map(sectionKey));
  });
});
