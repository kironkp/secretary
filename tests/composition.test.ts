// SPEC §2 "Composition" and §3 invariants 3, 4 and 7, as of v1.02: a render is
// composed, not chosen. Today's system plan gives the emphasis and the places
// of the sections that are not cards; the sections the user placed go back
// where he put them; the cards he did not place are in data order; then his
// hides and bans; then presence. Pure: the composition, the validator, the
// rules planner and the fallback chain, on made-up boards.
//
// The defect this replaces, as the Reviewer showed it: on a board nobody
// arranged, the card order stopped following the data as soon as any rule
// fired, because a card the data moved was "a system move with no why".
process.env.TZ = "UTC";

import { beforeEach, describe, expect, it } from "vitest";
import { composePlan, readPlaces } from "@/lib/layout/compose";
import { asPlace, defaultPlan, isUrgent, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { planFromRules } from "@/lib/layout/plan-from-rules";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import { movementReasons, validatePlan, type LayoutPreference, type ValidationContext } from "@/lib/layout/validator";
import type { ProjectSignal, Signals } from "@/lib/layout/signals";
import { baseSignals } from "./fixtures/layout";

/** One made-up project: `soonest` is calendar days to its earliest open task (negative = late). */
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
function board(late: number, days = 3): Signals {
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
  signals.context.days_since_layout_change = days;
  return signals;
}
/** The same board with one project's date changed, added, or removed. */
function changed(signals: Signals, change: (projects: ProjectSignal[]) => ProjectSignal[]): Signals {
  const next = structuredClone(signals);
  next.projects = change(next.projects);
  for (const p of next.projects) next.engagement[p.id] ??= { mentions_24h: 0, baseline_mentions: 2, last_touched: "2026-08-05T12:00:00Z" };
  return next;
}
const redate = (id: string, soonest: number | null) => (projects: ProjectSignal[]) =>
  projects.map((p) => (p.id === id ? { ...p, soonest_days: soonest, days_left: soonest !== null && soonest >= 0 ? soonest : null } : p));

const ctx = (signals: Signals, over: Partial<ValidationContext> = {}): ValidationContext => ({
  signals,
  previousPlan: null,
  preferences: [],
  pinnedSections: [],
  defaultPlan: defaultPlan(signals),
  ...over,
});
const keys = (plan: LayoutPlan) => plan.sections.map(sectionKey);
const cards = (plan: LayoutPlan) => plan.sections.filter((s) => s.component === "project_card").map((s) => String(s.props?.project_id));
const cardOf = (plan: LayoutPlan, id: string) => plan.sections.find((s) => s.props?.project_id === id);
const reasonsOf = (res: ReturnType<typeof validatePlan>) => (res.ok ? "ok" : res.reasons.join(" | "));
const compose = (system: LayoutPlan, signals: Signals, stored: LayoutPlan | null = null, pinned: string[] = [], preferences: LayoutPreference[] = []) =>
  composePlan(system, { signals, stored, pinned, preferences });
/** A board with every place read off it again, as a request stores it (SPEC §2: every place is read from the board he was told). */
function placesRead(sections: PlanSection[], placed: string[]): PlanSection[] {
  const places = readPlaces(sections, new Set(placed), { projects: [] } as unknown as Signals);
  return sections.map(({ place: _was, ...s }) => {
    void _was;
    const place = places.get(sectionKey(s));
    return place ? { ...s, place } : s;
  });
}
/** A stored plan with one section lifted out and put at a place on the board, as a request stores it. */
function pinnedAt(plan: LayoutPlan, key: string, index: number | "last"): LayoutPlan {
  const moved = plan.sections.find((s) => sectionKey(s) === key)!;
  const rest = plan.sections.filter((s) => s !== moved);
  const at = index === "last" ? rest.length : index;
  const sections = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return { ...plan, sections: placesRead(sections, [...sections.filter((s) => s.place !== undefined).map(sectionKey), key]) };
}
const render = (signals: Signals, stored: LayoutPlan | null, pinned: string[] = [], preferences: LayoutPreference[] = []) =>
  planWithFallback(signals, { previousPlan: stored, preferences, pinnedSections: pinned, llmEnabled: false });

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

describe("the default order of the cards", () => {
  it("urgent by a date the calendar count does not see (an event in three days) comes before a project due later", () => {
    const signals = board(0);
    signals.projects = [project("Later", 9), { ...project("Event soon", null), days_left: 3 }, project("Quiet", null), project("Groceries", -3, "list")];
    expect(cards(defaultPlan(signals))).toEqual(["event-soon", "later", "quiet", "groceries"]);
  });
});

describe.each([5, 6, 9])("a board with %i late projects", (late) => {
  const signals = board(late);

  it("the default is valid, urgent cards first, the list last", () => {
    const plan = defaultPlan(signals);
    expect(reasonsOf(validatePlan(plan, ctx(signals)))).toBe("ok");
    const urgentIds = signals.projects.filter(isUrgent).map((p) => p.id);
    expect(urgentIds).toHaveLength(late + 1);
    expect(cards(plan).slice(0, late + 1).toSorted()).toEqual(urgentIds.toSorted());
    expect(cards(plan).at(-1)).toBe("shopping");
  });

  it("the rules plan is valid, and a quiet project he talks about all day is emphasised without being moved", async () => {
    const busy = board(late);
    busy.engagement["quiet-two"] = { mentions_24h: 14, baseline_mentions: 2, last_touched: "2026-08-07T08:00:00Z" };
    const res = await render(busy, defaultPlan(busy));
    expect(res.source).toBe("rules");
    expect(cards(res.plan)).toEqual(cards(defaultPlan(busy)));
    expect(cardOf(res.plan, "quiet-two")).toMatchObject({ props: { variant: "full", inline_loops: true }, why: "14 mentions today vs 2 typical" });
  });

  it("a planner's card order is ignored: its plan is used, paid for, and the cards are in data order", async () => {
    const answer = defaultPlan(signals);
    const others = answer.sections.filter((s) => s.component !== "project_card");
    // The planner sends the cards backwards, the list first, and makes one compact.
    const sent = answer.sections
      .filter((s) => s.component === "project_card")
      .toReversed()
      .map((s) => (s.props?.project_id === "soon" ? { ...s, props: { ...s.props, variant: "compact" }, why: "Nothing to do yet" } : s));
    const shuffled: LayoutPlan = { plan_id: "anything", reason_summary: "Tidy", sections: [...others.slice(0, 3), ...sent, ...others.slice(3)] };
    const res = await planWithFallback(signals, { previousPlan: null, preferences: [], pinnedSections: [], llmEnabled: true, call: async () => JSON.stringify(shuffled) });
    expect(res.source).toBe("llm");
    expect(res.called).toBe(true);
    expect(cards(res.plan)).toEqual(cards(defaultPlan(signals)));
    expect(cardOf(res.plan, "soon")).toMatchObject({ props: { variant: "compact" }, why: "Nothing to do yet" });
    // The cached copy is composed again the same way.
    const again = await planWithFallback(signals, { previousPlan: null, preferences: [], pinnedSections: [], llmEnabled: true, call: async () => "never called" });
    expect(again.source).toBe("llm-cache");
    expect(cards(again.plan)).toEqual(cards(defaultPlan(signals)));
  });
});

describe("presence (invariant 4)", () => {
  const signals = board(6);

  it("a system plan without an urgent project's card is rejected", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, sections: plan.sections.filter((s) => s.props?.project_id !== "late-c") };
    expect(reasonsOf(validatePlan(without, ctx(signals)))).toMatch(/urgent project "Late C" \(4d late\) would have no card/);
  });

  it("so is a change the user asked for that would leave one out: hiding an urgent card is refused", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, plan_id: "user-x", sections: plan.sections.filter((s) => s.props?.project_id !== "soon") };
    expect(reasonsOf(validatePlan(without, ctx(signals, { previousPlan: plan, userInitiated: true })))).toMatch(/urgent project "Soon" \(3d\) would have no card/);
  });

  it("a list with late items is not urgent: a plan without its card is valid", () => {
    const plan = defaultPlan(signals);
    const without = { ...plan, sections: plan.sections.filter((s) => s.props?.project_id !== "shopping") };
    expect(reasonsOf(validatePlan(without, ctx(signals)))).toBe("ok");
  });

  it("a card he hid stays hidden while its project is quiet, and is back, in its place by the data, while it is late", () => {
    const hide: LayoutPreference[] = [{ kind: "hide_section", value: { section: "project_card:quiet-one" } }];
    const quiet = compose(defaultPlan(signals), signals, null, [], hide);
    expect(cards(quiet)).not.toContain("quiet-one");

    const late = changed(signals, redate("quiet-one", -1));
    const back = compose(defaultPlan(late), late, quiet, [], hide);
    expect(cards(back)).toEqual(cards(defaultPlan(late)));
    expect(cardOf(back, "quiet-one")?.why).toBe("Back on your board: it has late work");
    // Back on the board it is not a section he placed: it goes on following the data.
    const later = changed(late, redate("quiet-three", -20));
    expect(cards(compose(defaultPlan(later), later, back, [], hide))).toEqual(cards(defaultPlan(later)));
    const soon = changed(signals, redate("quiet-one", 2));
    expect(cardOf(compose(defaultPlan(soon), soon, quiet, [], hide), "quiet-one")?.why).toBe("Back on your board: it is due within a week");
  });

  it("a hidden section that is not a card stays hidden, and a banned component is on no board", () => {
    const prefs: LayoutPreference[] = [
      { kind: "hide_section", value: { section: "stat_row" } },
      { kind: "ban_component", value: { component: "people_index" } },
    ];
    expect(keys(compose(defaultPlan(signals), signals, null, [], prefs)).filter((k) => !k.startsWith("project_card:"))).toEqual(["hero_next_up", "timeline", "date_chase"]);
    // Pinned as well, they are still off the board: a hide or a ban beats a pin.
    const pinned = compose(defaultPlan(signals), signals, defaultPlan(signals), ["stat_row", "people_index"], prefs);
    expect(keys(pinned).filter((k) => !k.startsWith("project_card:"))).toEqual(["hero_next_up", "timeline", "date_chase"]);
  });

  it("with a component he has just banned still in the stored plan, the rules plan is judged without it: the ban, his hide and his pin all hold", async () => {
    const stored = pinnedAt(compose(defaultPlan(signals), signals), "project_card:shopping", 0);
    const prefs: LayoutPreference[] = [
      { kind: "ban_component", value: { component: "people_index" } },
      { kind: "hide_section", value: { section: "project_card:quiet-one" } },
    ];
    const res = await render(signals, stored, ["project_card:shopping"], prefs);
    // Round 4: "default". A rules plan carrying what he had banned was
    // refused, and the board fell back. A ban is his, and no longer gets the
    // system's own plan refused (SPEC §2).
    expect(res.source).toBe("rules");
    expect(keys(res.plan)).not.toContain("people_index");
    expect(keys(res.plan)).not.toContain("project_card:quiet-one");
    expect(keys(res.plan)[0]).toBe("project_card:shopping");
  });
});

// The Reviewer's three shapes and the control (~/code/sec-review j102r2, Q2 and
// Q5): the data changes, and the cards must be in the default order for the
// new data, whatever plan is stored.
describe("on a board he has not arranged, the cards follow the data", () => {
  const before = board(3);
  const shapes: [string, (p: ProjectSignal[]) => ProjectSignal[]][] = [
    ["control: nothing changes", (p) => p],
    ["(a) a quiet project becomes the most late", redate("quiet-three", -20)],
    ["(b) a late project becomes the most late", redate("late-a", -30)],
    ["(c) an undated project gets a date", redate("quiet-one", 12)],
    ["a late project is rescheduled into next month", redate("late-c", 30)],
    ["a project is made", (p) => [...p, project("Brand new", null)]],
    ["a project is archived", (p) => p.filter((x) => x.id !== "late-b")],
  ];
  // The planner's plan as stored: a banner, and the cards in an order of its own.
  const planners = (): LayoutPlan => {
    const base = defaultPlan(before);
    const others = base.sections.filter((s) => s.component !== "project_card");
    const own = base.sections.filter((s) => s.component === "project_card").toSorted((a, b) => String(a.props?.project_id).localeCompare(String(b.props?.project_id)));
    return {
      plan_id: "llm-old",
      reason_summary: "A busy week",
      sections: [{ component: "focus_banner", props: { text: "Three things are late", tone: "serious" } }, ...others.slice(0, 3), ...own, ...others.slice(3)],
    };
  };
  const heads: [string, () => LayoutPlan | null][] = [
    ["no stored plan", () => null],
    ["a stored default", () => defaultPlan(before)],
    ["a stored rules plan (rule 1 had fired)", () => planFromRules(before)],
    ["a stored planner plan", planners],
  ];

  it("rule 1 does fire on this board, so the stored rules plan is not the default", () => {
    expect(planFromRules(before).plan_id).toMatch(/^rules-/);
  });

  describe.each(heads)("with %s", (_head, stored) => {
    it.each(shapes)("%s", async (_shape, change) => {
      const after = changed(before, change);
      for (const days of [0, 3]) {
        const signals = structuredClone(after);
        signals.context.days_since_layout_change = days;
        const res = await render(signals, stored());
        expect(cards(res.plan), `days_since_layout_change ${days}`).toEqual(cards(defaultPlan(signals)));
      }
    });

    it.each(shapes)("with the list pinned to the top: %s; the list stays, the rest re-sort", async (_shape, change) => {
      const base = stored() ?? defaultPlan(before);
      const pinned = pinnedAt(compose(base, before), "project_card:shopping", 0);
      const after = changed(before, change);
      const res = await render(after, pinned, ["project_card:shopping"]);
      const shown = res.plan.sections.filter((s) => s.component !== "focus_banner");
      expect(sectionKey(shown[0])).toBe("project_card:shopping");
      expect(cards(res.plan).slice(1)).toEqual(cards(defaultPlan(after)).filter((id) => id !== "shopping"));
    });
  });

  it("a stored planner plan's emphasis and banner are used only for the signals it was written for", async () => {
    // Served from the stored plan (the caller found the same signals hash): banner and reason as stored, cards by the data.
    const stored = planners();
    const served = compose(stored, before, stored);
    expect(served.sections[0]).toMatchObject({ component: "focus_banner" });
    expect(served.reason_summary).toBe("A busy week");
    expect(cards(served)).toEqual(cards(defaultPlan(before)));
    // The signals changed a day or more later: the rules plan is today's, and the banner is gone.
    const later = changed(before, redate("late-a", -30));
    const res = await render(later, stored);
    expect(res.source).toBe("rules");
    expect(keys(res.plan)).not.toContain("focus_banner");
    // The same day, a removal waits (invariant 8): the banner stands, and still the cards follow the data.
    const sameDay = structuredClone(later);
    sameDay.context.days_since_layout_change = 0;
    const held = await render(sameDay, stored);
    expect(held.source).toBe("previous");
    expect(held.plan.sections[0]).toMatchObject({ component: "focus_banner" });
    expect(cards(held.plan)).toEqual(cards(defaultPlan(sameDay)));
  });
});

describe("when a system move is refused and the stored sections are held", () => {
  const before = board(3);
  const stored = (): LayoutPlan => {
    const base = defaultPlan(before);
    return { plan_id: "llm-old", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Three things are late", tone: "serious" } }, ...base.sections] };
  };

  it("a project made the same day, already late, has its card, first; the banner stands (its removal waits a day)", async () => {
    const sameDay = changed(before, (p) => [...p, project("Brand new", -40)]);
    sameDay.context.days_since_layout_change = 0;
    const res = await render(sameDay, stored());
    expect(res.source).toBe("previous");
    expect(res.plan.sections[0]).toMatchObject({ component: "focus_banner" });
    expect(cards(res.plan)[0]).toBe("brand-new");
    expect(cards(res.plan)).toEqual(cards(defaultPlan(sameDay)));
  });

  it("what he placed and hid holds on the held plan too: his list on top under the banner, the tiles hidden", async () => {
    const base = stored();
    const withPin = pinnedAt({ ...base, sections: base.sections.filter((s) => s.component !== "focus_banner") }, "project_card:shopping", 0);
    const held: LayoutPlan = { ...withPin, sections: [base.sections[0], ...withPin.sections] };
    const sameDay = changed(before, redate("quiet-three", -20));
    sameDay.context.days_since_layout_change = 0;
    const res = await render(sameDay, held, ["project_card:shopping"], [{ kind: "hide_section", value: { section: "stat_row" } }]);
    expect(res.source).toBe("previous");
    expect(keys(res.plan).slice(0, 2)).toEqual(["focus_banner", "project_card:shopping"]);
    expect(keys(res.plan)).not.toContain("stat_row");
    expect(cards(res.plan).slice(1)).toEqual(cards(defaultPlan(sameDay)).filter((id) => id !== "shopping"));
  });

  it("the cards carry today's emphasis, not the stored plan's: rule 1's why is today's count", async () => {
    const old = stored();
    old.sections = old.sections.map((s) => (s.props?.project_id === "soon" ? { ...s, props: { ...s.props, accent: true }, why: "Due in 6 days" } : s));
    const sameDay = structuredClone(before);
    sameDay.context.days_since_layout_change = 0;
    sameDay.projects = redate("late-a", -9)(sameDay.projects);
    const res = await render(sameDay, old);
    expect(res.source).toBe("previous");
    expect(cardOf(res.plan, "soon")).toMatchObject({ props: { accent: true }, why: "Due in 3 days" });
  });

  it("a planner cannot drop a card: its plan has none, and every card is there, under the strip, in data order", async () => {
    // Nothing urgent on this board, so a plan with no cards is a valid plan.
    const quiet = changed(board(0), (p) => p.filter((x) => x.id !== "soon"));
    const none: LayoutPlan = { plan_id: "x", reason_summary: "Lean", sections: defaultPlan(quiet).sections.filter((s) => s.component !== "project_card") };
    const res = await planWithFallback(quiet, { previousPlan: null, preferences: [], pinnedSections: [], llmEnabled: true, call: async () => JSON.stringify(none) });
    expect(res.source).toBe("llm");
    expect(keys(res.plan)).toEqual(keys(defaultPlan(quiet)));
  });
});

describe("movement is measured without the cards and without his pins (invariants 3 and 7)", () => {
  const signals = board(3);

  it("D2: a plan that differs from the stored one only in where the cards are moves nothing", () => {
    const stored = planFromRules(signals);
    const resorted = changed(signals, redate("quiet-three", -20));
    const composed = compose(planFromRules(resorted), resorted, stored);
    expect(cards(composed)).not.toEqual(cards(stored));
    for (const days of [0, 3]) {
      resorted.context.days_since_layout_change = days;
      expect(movementReasons(composed, ctx(resorted, { previousPlan: stored }))).toEqual([]);
    }
  });

  it("a section that is not a card still may not move the same day, nor without a why later", () => {
    const stored = { ...defaultPlan(signals), plan_id: "rules-w" };
    const strip = stored.sections.find((s) => s.component === "timeline")!;
    const moved: LayoutPlan = { ...stored, plan_id: "rules-x", sections: [strip, ...stored.sections.filter((s) => s !== strip)] };
    const sameDay = structuredClone(signals);
    sameDay.context.days_since_layout_change = 0;
    expect(movementReasons(moved, ctx(sameDay, { previousPlan: stored }))).toEqual(["reordering is rationed: layout already changed today"]);
    expect(movementReasons(moved, ctx(signals, { previousPlan: stored }))).toEqual(['moved section "timeline" has no why']);
  });

  it("D5: a pin is applied, not checked: with Needs a date pinned inside the cards, a new project does not get the rules plan refused", async () => {
    const stored = pinnedAt(compose(planFromRules(signals), signals), "date_chase", 5);
    const more = changed(signals, (p) => [...p, project("Brand new", -9)]);
    const res = await render(more, stored, ["date_chase"]);
    expect(res.source).toBe("rules");
    expect(keys(res.plan)[5]).toBe("date_chase");
    expect(cards(res.plan)[0]).toBe("brand-new");
  });

  it("D5: a pin holds the place, not the emphasis: rule 3 makes a pinned card compact, and that is not refused", async () => {
    const stored = pinnedAt(compose(defaultPlan(signals), signals), "project_card:quiet-two", 3);
    const talk = structuredClone(signals);
    talk.conversation.schedule_word_share = 0.5;
    const res = await render(talk, stored, ["project_card:quiet-two"]);
    expect(res.source).toBe("rules");
    expect(keys(res.plan)[0]).toBe("timeline");
    expect(cardOf(res.plan, "quiet-two")).toMatchObject({ props: { variant: "compact" }, place: { from: "top", n: 3 } });
    expect(keys(res.plan)[3]).toBe("project_card:quiet-two");
  });

  it("a pinned section that is not a card takes today's props too: the strip he moved opens when rule 3 fires", async () => {
    const stored = pinnedAt(compose(defaultPlan(signals), signals), "timeline", 4);
    const talk = structuredClone(signals);
    talk.conversation.schedule_word_share = 0.5;
    const res = await render(talk, stored, ["timeline"]);
    expect(res.source).toBe("rules");
    expect(res.plan.sections[4]).toMatchObject({ component: "timeline", props: { span_days: 14, expanded: true }, place: { from: "top", n: 4 } });
    expect(res.plan.sections[4].why).toMatch(/talking dates/);
  });

  it("what he placed stays and a system move lands below it: his list on top, rule 3's timeline second", async () => {
    const stored = pinnedAt(compose(defaultPlan(signals), signals), "project_card:shopping", 0);
    const talk = structuredClone(signals);
    talk.conversation.schedule_word_share = 0.5;
    const res = await render(talk, stored, ["project_card:shopping"]);
    expect(res.source).toBe("rules");
    expect(keys(res.plan).slice(0, 3)).toEqual(["project_card:shopping", "timeline", "hero_next_up"]);
  });
});

// What a pin holds (SPEC §2): the section's place on the board, the n-th
// section from the top, stored when it was pinned; last holds last. The five
// shapes the two tools can make, each with the data changing underneath.
describe("a section he placed stays where he put it", () => {
  const signals = board(2);
  const base = compose(defaultPlan(signals), signals);
  const firstCard = keys(base).findIndex((k) => k.startsWith("project_card:"));
  const changes: [string, Signals][] = [
    ["nothing changed", signals],
    ["a project was made, most late of all", changed(signals, (p) => [...p, project("Brand new", -40)])],
    ["a project was archived", changed(signals, (p) => p.filter((x) => x.id !== "late-a"))],
    ["a quiet project went late", changed(signals, redate("quiet-three", -15))],
  ];
  const shapes: [string, string, number | "last"][] = [
    ["a card at the very top of the board", "project_card:shopping", 0],
    ["a card at the very bottom of the board", "project_card:late-a", "last"],
    ["the first card moved up one: between the tiles and the strip", "project_card:late-b", firstCard - 1],
    ["Needs a date moved up one: inside the card run", "date_chase", keys(base).indexOf("date_chase") - 1],
    ["the strip moved down one: after the first card", "timeline", keys(base).indexOf("timeline") + 1],
  ];

  describe.each(shapes)("%s", (_what, key, index) => {
    const stored = pinnedAt(base, key, index);
    const place = asPlace(stored.sections.find((s) => sectionKey(s) === key)!.place)!;

    it("its place is counted from the top; from the bottom when no card of the run and none of the upper sections stands below it", () => {
      // Round 3 wrote a number from the top, or "last". A place is now a
      // position on the board he was told, counted from whichever end it
      // belongs to: the bottom stays the bottom when a project is made.
      expect(place).toEqual(index === "last" ? { from: "bottom", n: 0 } : { from: "top", n: index });
    });

    it.each(changes)("%s: it is at its place, and the cards he did not place are in data order around it", async (_change, now) => {
      const gone = key.startsWith("project_card:") && !now.projects.some((p) => `project_card:${p.id}` === key);
      const res = await render(now, stored, [key]);
      const shown = keys(res.plan);
      if (gone) {
        expect(shown).not.toContain(key); // an archived project has no card, pinned or not
      } else if (place.from === "bottom") {
        expect(shown.at(-1 - place.n)).toBe(key);
      } else {
        expect(shown[place.n]).toBe(key);
      }
      const others = cards(res.plan).filter((id) => `project_card:${id}` !== key);
      expect(others).toEqual(cards(defaultPlan(now)).filter((id) => `project_card:${id}` !== key));
      // The place is stored with the section, so the next render reads the same one.
      if (!gone) expect(res.plan.sections.find((s) => sectionKey(s) === key)?.place).toEqual(place);
    });
  });

  it("with fewer sections than its place it is last, and it is back at its place when they return: no drift", () => {
    const stored = pinnedAt(base, "date_chase", 7);
    const few = changed(signals, (p) => p.filter((x) => ["late-a", "shopping"].includes(x.id)));
    const shrunk = compose(defaultPlan(few), few, stored, ["date_chase"]);
    expect(keys(shrunk).at(-1)).toBe("date_chase");
    // The shrunken board is what is stored now; the projects come back.
    const again = compose(defaultPlan(signals), signals, shrunk, ["date_chase"]);
    expect(keys(again)[7]).toBe("date_chase");
  });

  it("a pin with no place written (a row from before r5, a preference pin): it is read once from where the section stands, and kept", () => {
    const stored = compose(defaultPlan(signals), signals); // nothing carries a place
    const key = "project_card:quiet-one";
    const at = keys(stored).indexOf(key);
    const first = compose(defaultPlan(signals), signals, stored, [key]);
    expect(first.sections[at]).toMatchObject({ props: { project_id: "quiet-one" }, place: { from: "top", n: at } });
    // The data changes; the place does not.
    const later = changed(signals, (p) => [...p, project("Brand new", -40)]);
    expect(keys(compose(defaultPlan(later), later, first, [key]))[at]).toBe(key);
    // A pin kept as a preference (before r5) is a pin too, until it has been
    // given its place: then the row is marked, and no longer read as one.
    const viaPreference = compose(defaultPlan(later), later, first, [], [{ kind: "pin_section", value: { section: key } }]);
    expect(keys(viaPreference)[at]).toBe(key);
    const marked = compose(defaultPlan(later), later, first, [], [{ kind: "pin_section", value: { section: key, migrated: "1" } }]);
    expect(cards(marked)).toEqual(cards(defaultPlan(later)));
    // Unpinned, it goes back to following the data.
    expect(cards(compose(defaultPlan(later), later, first))).toEqual(cards(defaultPlan(later)));
    // Read from a stored plan that has a banner: the banner is not a place.
    const bannered: LayoutPlan = { ...stored, sections: [{ component: "focus_banner", props: { text: "Two things are late", tone: "serious" } }, ...stored.sections] };
    expect(keys(compose(defaultPlan(signals), signals, bannered, [key]))[at]).toBe(key);
  });

  it("two he placed never meet at one place: each has its own position on the board he was told, from the top or from the bottom", () => {
    // Round 3 let two sections hold the same number ("0, 0, last, last") and
    // broke the tie by the stored order; composing again turned them over.
    // That rule is gone on purpose: a place is a position on one real board,
    // read again for every placed section after each request, so the places
    // are distinct and there is no tie to break.
    const top = pinnedAt(pinnedAt(base, "project_card:shopping", 0), "date_chase", 0);
    const both = pinnedAt(pinnedAt(top, "project_card:late-a", "last"), "project_card:quiet-one", "last");
    const pins = ["project_card:shopping", "date_chase", "project_card:late-a", "project_card:quiet-one"];
    expect(both.sections.filter((s) => s.place !== undefined).map((s) => s.place)).toEqual([
      { from: "top", n: 0 },
      { from: "top", n: 1 },
      { from: "bottom", n: 1 },
      { from: "bottom", n: 0 },
    ]);
    for (const [, now] of changes) {
      const shown = keys(compose(planFromRules(now), now, both, pins));
      expect(shown.slice(0, 2)).toEqual(["date_chase", "project_card:shopping"]);
      expect(shown.slice(-2)).toEqual(now.projects.some((p) => p.id === "late-a") ? ["project_card:late-a", "project_card:quiet-one"] : [shown.at(-2), "project_card:quiet-one"]);
    }
  });

  it("on a board too short for their places, two he placed keep the order he was told, and composing the result again changes nothing", () => {
    // The state rounds 3 and 4 failed on: two sections placed far down a long
    // board, which then grows short. Round 4 put both at the end and turned
    // them over at every compose (A,B then B,A then A,B).
    const long = pinnedAt(pinnedAt(base, "date_chase", 6), "people_index", 7);
    const pins = ["date_chase", "people_index"];
    const few = changed(signals, (p) => p.filter((x) => x.id === "shopping"));
    const once = compose(defaultPlan(few), few, long, pins);
    expect(keys(once).slice(-2)).toEqual(["date_chase", "people_index"]);
    const twice = compose(once, few, once, pins);
    expect(keys(twice)).toEqual(keys(once));
    expect(keys(compose(twice, few, twice, pins))).toEqual(keys(once));
    // The projects come back: each is at the place it was told, since nothing was said meanwhile.
    const back = keys(compose(defaultPlan(signals), signals, twice, pins));
    expect([back[6], back[7]]).toEqual(["date_chase", "people_index"]);
  });

  it("the banner is not counted: a section pinned at the top is first under it, and first when it is gone", () => {
    const stored = pinnedAt(base, "project_card:shopping", 0);
    const withBanner: LayoutPlan = { ...defaultPlan(signals), plan_id: "llm-x", sections: [{ component: "focus_banner", props: { text: "Two things are late", tone: "serious" } }, ...defaultPlan(signals).sections] };
    expect(keys(compose(withBanner, signals, stored, ["project_card:shopping"])).slice(0, 2)).toEqual(["focus_banner", "project_card:shopping"]);
    expect(keys(compose(defaultPlan(signals), signals, stored, ["project_card:shopping"]))[0]).toBe("project_card:shopping");
  });

  it("a section he added is placed too: the system's plan does not have it, the stored one keeps it", () => {
    const added: PlanSection = { component: "kanban", place: { from: "top", n: 1 } };
    const stored: LayoutPlan = { ...base, sections: [base.sections[0], added, ...base.sections.slice(1)] };
    const later = changed(signals, redate("quiet-three", -15));
    const res = compose(planFromRules(later), later, stored, ["kanban"]);
    expect(keys(res)[1]).toBe("kanban");
    expect(cards(res)).toEqual(cards(defaultPlan(later)));
    // Not on the row's pins, the place written on it is not read (round 4
    // kept such a section "at the place stored with it"; gone on purpose). A
    // section he added is never let go in the first place: the request
    // refuses to unpin it (lib/layout/request.ts), so this state is not one a
    // request leaves; if a row has it, the system's plan decides, and it has
    // none.
    expect(keys(compose(planFromRules(later), later, stored))).not.toContain("kanban");
    // With no place stored and no pin, it is not his either.
    const unplaced: LayoutPlan = { ...stored, sections: stored.sections.map((s) => (s.component === "kanban" ? { component: "kanban" } : s)) };
    expect(keys(compose(planFromRules(later), later, unplaced))).not.toContain("kanban");
  });

  it("a pin holds the place only: the card's emphasis and why are today's, not the day he pinned it", () => {
    const stale: LayoutPlan = pinnedAt(base, "project_card:soon", 3);
    stale.sections = stale.sections.map((s) => (s.props?.project_id === "soon" ? { ...s, props: { ...s.props, accent: true, inline_loops: true }, why: "Due in 3 days" } : s));
    // Five days on it is two days late; rule 1 no longer fires for it.
    const later = changed(signals, redate("soon", -2));
    const res = compose(planFromRules(later), later, stale, ["project_card:soon"]);
    const card = cardOf(res, "soon")!;
    expect(keys(res)[3]).toBe("project_card:soon");
    expect(card.why).toBeUndefined();
    expect(card.props?.accent).not.toBe(true);
  });
});

describe("rule 1's why counts calendar days in his zone, like the date beside it", () => {
  const due = (days_left: number, soonest_days: number | null, extra: Partial<ProjectSignal> = {}) => {
    const signals = board(0);
    signals.projects = [{ ...project("Report", soonest_days), days_left, ...extra }];
    return cardOf(planFromRules(signals), "report")?.why;
  };

  it("in the evening, a task due tomorrow at 5 PM is under 24 hours away: the chip says tomorrow, not 0 days", () => {
    expect(due(0, 1)).toBe("Due tomorrow");
  });
  it("three calendar days out is two whole days and some hours: the chip says 3", () => {
    expect(due(2, 3)).toBe("Due in 3 days");
  });
  it("due later today", () => {
    expect(due(0, 0)).toBe("Due today");
  });
  it("a committed deadline is counted the same way, and says it is one", () => {
    expect(due(1, null, { deadline_type: "committed", deadline_days: 2 })).toBe("Due in 2 days — you committed to this date");
  });
  it("with a committed deadline and an earlier task, the why names the committed date", () => {
    expect(due(3, 1, { deadline_type: "committed", deadline_days: 4 })).toBe("Due in 4 days — you committed to this date");
  });
  it("a date the calendar count does not see (an event) falls back to days_left", () => {
    expect(due(2, null)).toBe("Due in 2 days");
  });
});
