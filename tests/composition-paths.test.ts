// SPEC §2 "Composition" (v1.02 r4): every pin shape on every path a render
// can take. r3 held a pinned card above the system's sections on the fresh
// path only; on the HELD path (the rules plan refused, the stored sections
// kept) his list pinned on top was taken for "the first card", and the whole
// board went under the cards. Here each path is rendered with each shape of
// pin and each change in the data, and the same things are asked of all of
// them. Pure: the composition and the fallback chain, on made-up boards.
process.env.TZ = "UTC";

import { beforeEach, describe, expect, it } from "vitest";
import { composePlan, ownSections, placeOn, placedKeys, runPlace } from "@/lib/layout/compose";
import { deadlineWhy, defaultPlan, isDeadlineWhy, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { planFromRules } from "@/lib/layout/plan-from-rules";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import type { LayoutPreference } from "@/lib/layout/validator";
import type { ProjectSignal, Signals } from "@/lib/layout/signals";
import { baseSignals } from "./fixtures/layout";

// --- a made-up board ---------------------------------------------------------
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
/** Three late projects, one due in three days (rule 1 fires for it), three quiet ones and a list. */
function board(): Signals {
  const signals = baseSignals();
  signals.projects = [
    project("Late A", -2),
    project("Late B", -3),
    project("Late C", -4),
    project("Soon", 3),
    project("Quiet one", null),
    project("Quiet two", 40),
    project("Quiet three", null),
    project("Shopping", -30, "list"),
  ];
  signals.engagement = Object.fromEntries(
    signals.projects.map((p) => [p.id, { mentions_24h: 0, baseline_mentions: 2, last_touched: "2026-08-05T12:00:00Z" }])
  );
  signals.context.days_since_layout_change = 3;
  return signals;
}
const redate = (id: string, soonest: number | null) => (projects: ProjectSignal[]) =>
  projects.map((p) => (p.id === id ? { ...p, soonest_days: soonest, days_left: soonest !== null && soonest >= 0 ? soonest : null } : p));
function changed(signals: Signals, change: (projects: ProjectSignal[]) => ProjectSignal[]): Signals {
  const next = structuredClone(signals);
  next.projects = change(next.projects);
  for (const p of next.projects) next.engagement[p.id] ??= { mentions_24h: 0, baseline_mentions: 2, last_touched: "2026-08-05T12:00:00Z" };
  return next;
}
const BANNER: PlanSection = { component: "focus_banner", props: { text: "Three things are late", tone: "serious" } };
const keys = (plan: LayoutPlan) => plan.sections.map(sectionKey);
const isCard = (key: string) => key.startsWith("project_card:");
const cardKeys = (plan: LayoutPlan) => keys(plan).filter(isCard);
const compose = (system: LayoutPlan, signals: Signals, stored: LayoutPlan | null, pinned: string[], preferences: LayoutPreference[] = []) =>
  composePlan(system, { signals, stored, pinned, preferences });

// --- pins --------------------------------------------------------------------
/** Where a pin goes on a stored board (its sections without the banner): an index, or last. */
type Pin = { key: string; at: (board: string[]) => number | "last" };
/** A stored plan with a section lifted out and put at a place, as a tool saves it. */
function pinned(plan: LayoutPlan, pin: Pin): LayoutPlan {
  const banner = plan.sections.filter((s) => s.component === "focus_banner");
  const body = plan.sections.filter((s) => s.component !== "focus_banner");
  const moved = body.find((s) => sectionKey(s) === pin.key)!;
  const rest = body.filter((s) => s !== moved);
  const where = pin.at(body.map(sectionKey));
  const index = where === "last" ? rest.length : where;
  const sections = [...rest.slice(0, index), moved, ...rest.slice(index)];
  const place = placeOn(sections, pin.key)!;
  return { ...plan, sections: [...banner, ...sections.map((s) => (s === moved ? { ...s, place } : s))] };
}
const firstCardAt = (b: string[]) => b.findIndex(isCard);
const SHAPES: [string, Pin[]][] = [
  ["nothing pinned", []],
  ["the list on top", [{ key: "project_card:shopping", at: () => 0 }]],
  ["a card at the very bottom", [{ key: "project_card:late-a", at: () => "last" }]],
  ["the first card up one", [{ key: "project_card:late-c", at: (b) => Math.max(0, firstCardAt(b) - 1) }]],
  ["Needs a date up one, into the cards", [{ key: "date_chase", at: (b) => b.indexOf("date_chase") - 1 }]],
  ["the strip down one", [{ key: "timeline", at: (b) => b.indexOf("timeline") + 1 }]],
  ["the tiles to the bottom", [{ key: "stat_row", at: () => "last" }]],
  ["the list on top and Needs a date in the cards", [{ key: "project_card:shopping", at: () => 0 }, { key: "date_chase", at: (b) => b.indexOf("date_chase") - 2 }]],
];

// --- the data changing underneath ---------------------------------------------
const CHANGES: [string, (p: ProjectSignal[]) => ProjectSignal[]][] = [
  ["nothing changes", (p) => p],
  ["a quiet project becomes the most late", redate("quiet-three", -20)],
  ["a late project becomes the most late", redate("late-a", -30)],
  ["an undated project gets a date", redate("quiet-one", 12)],
  ["a project is made, already late", (p) => [...p, project("Brand new", -9)]],
  ["a project is archived", (p) => p.filter((x) => x.id !== "late-b")],
];

// --- the paths a render can take ------------------------------------------------
type Rendered = { plan: LayoutPlan; source: string };
type Path = {
  name: string;
  /** What is stored before he pins anything. */
  stored: (before: Signals) => LayoutPlan;
  /** Today's signals for this path, from the changed data. */
  today?: (after: Signals) => Signals;
  preferences?: LayoutPreference[];
  render: (after: Signals, stored: LayoutPlan, pins: string[], preferences: LayoutPreference[]) => Promise<Rendered>;
  /** The source with nothing of the system's pinned. */
  source: string;
  /** The system's own order for this path: its sections that are not cards, with "cards" where the run goes. */
  order: string[];
};
const talk = (signals: Signals): Signals => {
  const next = structuredClone(signals);
  next.conversation.schedule_word_share = 0.5;
  return next;
};
const sameDay = (signals: Signals): Signals => {
  const next = structuredClone(signals);
  next.context.days_since_layout_change = 0;
  return next;
};
/** A planner's answer for these signals: a banner, the strip sent to the top with a reason, the cards backwards. */
function plannersPlan(signals: Signals, moveStrip: boolean): LayoutPlan {
  const base = defaultPlan(signals);
  const others = base.sections.filter((s) => s.component !== "project_card");
  // Opened as well as moved: a why on a section left exactly as the default has it is stripped as self-talk.
  const strip: PlanSection = { component: "timeline", props: { span_days: 14, expanded: true }, why: "Dates first this week" };
  const rest = others.filter((s) => s.component !== "timeline");
  const cards = base.sections.filter((s) => s.component === "project_card").toReversed();
  const top = moveStrip ? [strip, ...rest.slice(0, 2)] : [...rest.slice(0, 2), others.find((s) => s.component === "timeline")!];
  return { plan_id: "llm-old", reason_summary: "A busy week", sections: [BANNER, ...top, ...cards, ...rest.slice(2)] };
}
const viaChain = (llm: false | ((signals: Signals) => LayoutPlan)) =>
  async (after: Signals, stored: LayoutPlan, pins: string[], preferences: LayoutPreference[]): Promise<Rendered> =>
    planWithFallback(after, {
      previousPlan: stored,
      preferences,
      pinnedSections: pins,
      llmEnabled: llm !== false,
      call: llm === false ? undefined : async () => JSON.stringify(llm(after)),
    });
const DEFAULT_ORDER = ["hero_next_up", "stat_row", "timeline", "cards", "date_chase", "people_index"];
const PATHS: Path[] = [
  { name: "the rules plan, fresh", stored: (b) => defaultPlan(b), render: viaChain(false), source: "rules", order: DEFAULT_ORDER },
  {
    name: "the stored plan served from the cache",
    stored: (b) => planFromRules(b),
    render: async (after, stored, pins, preferences) => ({ plan: compose(stored, after, stored, pins, preferences), source: "cache" }),
    source: "cache",
    order: DEFAULT_ORDER,
  },
  {
    name: "a planner's plan",
    stored: (b) => defaultPlan(b),
    render: viaChain((s) => plannersPlan(s, true)),
    source: "llm",
    order: ["focus_banner", "timeline", "hero_next_up", "stat_row", "cards", "date_chase", "people_index"],
  },
  {
    name: "a planner's plan from the in-memory cache",
    stored: (b) => defaultPlan(b),
    render: async (after, stored, pins, preferences) => {
      await viaChain((s) => plannersPlan(s, true))(after, stored, pins, preferences);
      return planWithFallback(after, { previousPlan: stored, preferences, pinnedSections: pins, llmEnabled: true, call: async () => "never asked" });
    },
    source: "llm-cache",
    order: ["focus_banner", "timeline", "hero_next_up", "stat_row", "cards", "date_chase", "people_index"],
  },
  {
    name: "held: a planner's banner the same day (its removal waits)",
    stored: (b) => plannersPlan(b, false),
    today: sameDay,
    render: viaChain(false),
    source: "previous",
    order: ["focus_banner", "hero_next_up", "stat_row", "timeline", "cards", "date_chase", "people_index"],
  },
  {
    name: "held: rule 3 sent the strip up, and the talk has stopped",
    stored: (b) => planFromRules(talk(b)),
    render: viaChain(false),
    source: "previous",
    order: ["timeline", "hero_next_up", "stat_row", "cards", "date_chase", "people_index"],
  },
  {
    name: "the default, composed (the stored plan has a component he has banned)",
    stored: (b) => defaultPlan(b),
    preferences: [{ kind: "ban_component", value: { component: "people_index" } }],
    render: viaChain(false),
    source: "default",
    order: ["hero_next_up", "stat_row", "timeline", "cards", "date_chase"],
  },
  {
    name: "calm mode",
    stored: (b) => planFromRules(b),
    render: async (after, stored, pins, preferences) => ({ plan: compose(defaultPlan(after), after, stored, pins, preferences), source: "calm" }),
    source: "calm",
    order: DEFAULT_ORDER,
  },
];

beforeEach(() => clearPlanCache());

describe.each(PATHS)("on the path: $name", (path) => {
  const before = board();
  /** The stored board before he pins anything: the path's stored plan, composed. */
  const base = compose(path.stored(before), before, null, []);

  it("with nothing pinned, the system's sections are in its order and the cards are one run in data order", async () => {
    const after = (path.today ?? ((s) => s))(before);
    const res = await path.render(after, base, [], path.preferences ?? []);
    expect(res.source).toBe(path.source);
    const run = cardKeys(defaultPlan(after));
    expect(keys(res.plan)).toEqual(path.order.flatMap((k) => (k === "cards" ? run : [k])));
  });

  describe.each(SHAPES)("%s", (_shape, pins) => {
    const stored = pins.reduce((plan, pin) => pinned(plan, pin), base);
    const pinnedKeys = pins.map((p) => p.key);
    const places = new Map(stored.sections.filter((s) => s.place !== undefined).map((s) => [sectionKey(s), s.place!]));

    it.each(CHANGES)("%s", async (_change, change) => {
      const after = (path.today ?? ((s) => s))(changed(before, change));
      const preferences = path.preferences ?? [];
      const res = await path.render(after, stored, pinnedKeys, preferences);
      const bare = await path.render(after, base, [], preferences);
      const shown = keys(res.plan);
      const active = new Set(after.projects.map((p) => `project_card:${p.id}`));
      const here = pinnedKeys.filter((k) => !isCard(k) || active.has(k));

      // The same path, unless the one section whose move held the plan is his now.
      const held = path.source === "previous" && path.name.includes("rule 3") && pinnedKeys.includes("timeline");
      expect(res.source).toBe(held ? "rules" : path.source);

      // 1. What he placed is at its place; an archived project has no card, pinned or not.
      const body = shown.filter((k) => k !== "focus_banner");
      for (const key of pinnedKeys) {
        if (!here.includes(key)) expect(shown, key).not.toContain(key);
        else if (places.get(key) === "last") expect(body.at(-1), key).toBe(key);
        else expect(body[places.get(key) as number], key).toBe(key);
      }
      // 2. Nothing else is where it is because of his pins: take them out of
      // both boards, and the rest is the board with nothing pinned.
      const without = (list: string[]) => list.filter((k) => !pinnedKeys.includes(k));
      expect(without(shown)).toEqual(without(keys(bare.plan)));
      // 3. The cards he did not place are in data order.
      expect(without(cardKeys(res.plan))).toEqual(without(cardKeys(defaultPlan(after))));
      // 4. One card for every active project and list, none twice, none for a project that is gone.
      expect(cardKeys(res.plan).toSorted()).toEqual([...active].toSorted());
      expect(new Set(shown).size).toBe(shown.length);
      // 5. A banner, when there is one, is first.
      expect(shown.indexOf("focus_banner")).toBeLessThanOrEqual(0);
      // 6. The system's own sections are above and below the cards as its
      // order has them: never all of them under the cards.
      const own = without(shown).filter((k) => k !== "focus_banner");
      const firstCard = own.findIndex(isCard);
      expect(own.slice(0, firstCard)).toEqual(path.order.filter((k) => k !== "focus_banner").slice(0, path.order.filter((k) => k !== "focus_banner").indexOf("cards")).filter((k) => !pinnedKeys.includes(k)));
      // 7. A reason that counts days counts them today.
      for (const s of res.plan.sections) {
        if (!isDeadlineWhy(s.why)) continue;
        const p = after.projects.find((x) => x.id === s.props?.project_id)!;
        expect(s.why).toBe(deadlineWhy(p));
      }
      // 8. The place is stored with the section again, so the next render reads the same one.
      for (const key of here) expect(res.plan.sections.find((s) => sectionKey(s) === key)?.place, key).toBe(places.get(key));
    });
  });
});

describe("where the card run goes is one rule", () => {
  const signals = board();
  const plan = defaultPlan(signals);

  it("a plan's own sections are its sections without the banner and without what he placed", () => {
    const withBanner = { ...plan, sections: [BANNER, ...plan.sections] };
    const own = ownSections(withBanner.sections, new Set(["project_card:shopping", "stat_row"])).map(sectionKey);
    expect(own).not.toContain("focus_banner");
    expect(own).not.toContain("project_card:shopping");
    expect(own).not.toContain("stat_row");
    expect(own).toHaveLength(plan.sections.length - 2);
  });

  it("the run goes where the plan's first own card is; his pinned card in front of everything does not say", () => {
    const listOnTop = pinned(plan, { key: "project_card:shopping", at: () => 0 });
    expect(sectionKey(listOnTop.sections[0])).toBe("project_card:shopping");
    const placed = placedKeys(listOnTop, ["project_card:shopping"], []);
    expect([...placed]).toEqual(["project_card:shopping"]);
    expect(runPlace(ownSections(listOnTop.sections, placed))).toBe(3); // after next up, the tiles and the strip
    // Read without that rule, the run would go to the very top.
    expect(runPlace(listOnTop.sections)).toBe(0);
  });

  it("a plan with no card of its own has the run under the strip, wherever the strip is", () => {
    const none = plan.sections.filter((s) => s.component !== "project_card");
    expect(runPlace(none)).toBe(3);
    expect(runPlace([none[2], none[0], none[1], ...none.slice(3)])).toBe(3);
    expect(runPlace(none.filter((s) => s.component !== "timeline"))).toBe(2);
    expect(runPlace([])).toBe(0);
  });

  it("a pin that is not on the stored plan places nothing", () => {
    expect([...placedKeys(plan, ["kanban"], [{ kind: "pin_section", value: { section: "documents" } }])]).toEqual([]);
    expect([...placedKeys(null, ["stat_row"], [])]).toEqual([]);
  });
});

describe("a reason that counts days is today's count on every render (the chip under a deadline)", () => {
  /** One project due tomorrow at 5 PM, seen the evening before: under 24 hours away, one calendar day. */
  const evening = (): Signals => {
    const signals = board();
    signals.projects = [{ ...project("Report", 1), days_left: 0 }, project("Quiet one", null)];
    return signals;
  };
  /** The next morning: still under 24 hours away (the cache key has not moved), and now it is today. */
  const morning = (): Signals => {
    const signals = evening();
    signals.projects = [{ ...signals.projects[0], soonest_days: 0 }, signals.projects[1]];
    return signals;
  };
  const whyOf = (plan: LayoutPlan) => plan.sections.find((s) => s.props?.project_id === "report")?.why;

  it("the stored plan served the next morning says today, not tomorrow", () => {
    const stored = compose(planFromRules(evening()), evening(), null, []);
    expect(whyOf(stored)).toBe("Due tomorrow");
    expect(whyOf(compose(stored, morning(), stored, []))).toBe("Due today");
  });

  it("so does a board he arranged, a planner's plan that kept the wording, and the wording from before v1.02", () => {
    const base = compose(planFromRules(evening()), evening(), null, []);
    const his = pinned(base, { key: "project_card:quiet-one", at: () => 0 });
    expect(whyOf(compose(his, morning(), his, ["project_card:quiet-one"]))).toBe("Due today");
    for (const old of ["Due tomorrow", "Due in 0 days", "Due in 1 day", "Due in 3 days", "Due today"]) {
      const planners: LayoutPlan = { ...base, plan_id: "llm-x", sections: base.sections.map((s) => (s.props?.project_id === "report" ? { ...s, why: old } : s)) };
      expect(whyOf(compose(planners, morning(), planners, [])), old).toBe("Due today");
    }
  });

  it("a committed date keeps saying it is one, with today's count", () => {
    const signals = morning();
    signals.projects = [{ ...signals.projects[0], deadline_type: "committed", deadline_days: 2 }, signals.projects[1]];
    const base = compose(planFromRules(evening()), evening(), null, []);
    const stale: LayoutPlan = { ...base, sections: base.sections.map((s) => (s.props?.project_id === "report" ? { ...s, why: "Due in 3 days — you committed to this date" } : s)) };
    expect(whyOf(compose(stale, signals, stale, []))).toBe("Due in 2 days — you committed to this date");
  });

  it("a planner's own words are left alone, and so is a 'Due' on a project with no date to count to", () => {
    const base = compose(planFromRules(evening()), evening(), null, []);
    const words = (why: string, id: string): LayoutPlan => ({ ...base, plan_id: "llm-x", sections: base.sections.map((s) => (s.props?.project_id === id ? { ...s, props: { ...s.props, variant: "compact" }, why } : s)) });
    for (const why of ["Due soon, look at this first", "Nothing due", "Overdue by a week", "due tomorrow"]) {
      expect(whyOf(compose(words(why, "report"), morning(), null, [])), why).toBe(why);
    }
    const undated = compose(words("Due tomorrow", "quiet-one"), morning(), null, []);
    expect(undated.sections.find((s) => s.props?.project_id === "quiet-one")?.why).toBe("Due tomorrow");
  });

  it("what rule 1 writes is what the composition recognises", () => {
    for (const p of [{ ...project("A", 0) }, { ...project("B", 1) }, { ...project("C", 5) }, { ...project("D", 2), deadline_type: "committed" as const, deadline_days: 2 }]) {
      expect(isDeadlineWhy(deadlineWhy(p)), deadlineWhy(p) ?? "").toBe(true);
    }
    expect(deadlineWhy(project("Nothing", null))).toBeNull();
    expect(deadlineWhy(project("Late", -3))).toBeNull();
    for (const not of [undefined, null, "", "Due", "Back on your board: it has late work", "14 mentions today vs 2 typical"]) expect(isDeadlineWhy(not)).toBe(false);
  });
});
