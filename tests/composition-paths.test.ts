// SPEC §2 "Composition" (v1.02 r4): every pin shape on every path a render
// can take. r3 held a pinned card above the system's sections on the fresh
// path only; on the HELD path (the rules plan refused, the stored sections
// kept) his list pinned on top was taken for "the first card", and the whole
// board went under the cards. Here each path is rendered with each shape of
// pin and each change in the data, and the same things are asked of all of
// them. Pure: the composition and the fallback chain, on made-up boards.
process.env.TZ = "UTC";

import { beforeEach, describe, expect, it } from "vitest";
import { bannerFirst, composePlan, ownSections, placedKeys, readPlaces, runPlace } from "@/lib/layout/compose";
import { asPlace, deadlineWhy, defaultPlan, isDeadlineWhy, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
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
  // Every place is read again from the board he is told (SPEC §2).
  const placed = new Set([...sections.filter((s) => s.place !== undefined).map(sectionKey), pin.key]);
  const places = readPlaces(sections, placed, { projects: [] } as unknown as Signals);
  return {
    ...plan,
    sections: [
      ...banner,
      ...sections.map(({ place: _was, ...s }) => {
        void _was;
        const place = places.get(sectionKey(s));
        return place ? { ...s, place } : s;
      }),
    ],
  };
}
const firstCardAt = (b: string[]) => b.findIndex(isCard);
/** The rule for what he placed, written out again here so the test does not borrow the product's: see SPEC §2. */
function placeInto(flow: string[], told: { key: string; from: "top" | "bottom"; n: number }[]): string[] {
  const seq = [...flow];
  const total = flow.length + told.length;
  let last = -1;
  for (const t of told.filter((x) => x.from === "top").toSorted((a, b) => a.n - b.n)) {
    const at = Math.max(Math.min(t.n, seq.length), last + 1);
    seq.splice(at, 0, t.key);
    last = at;
  }
  for (const t of told.filter((x) => x.from === "bottom").toSorted((a, b) => b.n - a.n)) {
    const at = Math.max(Math.min(total - 1 - t.n, seq.length), last + 1);
    seq.splice(at, 0, t.key);
    last = at;
  }
  return seq;
}
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
    // Round 4 reached the default here: a rules plan carrying a component he
    // had banned was refused. A ban is his, and no longer gets the system's
    // plan refused (SPEC §2): the rules plan is judged without it.
    name: "the rules plan with a component he has just banned still in the stored plan",
    stored: (b) => defaultPlan(b),
    preferences: [{ kind: "ban_component", value: { component: "people_index" } }],
    render: viaChain(false),
    source: "rules",
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
    const withPlaces = pins.reduce((plan, pin) => pinned(plan, pin), base);
    const pinnedKeys = pins.map((p) => p.key);
    const places = new Map(withPlaces.sections.filter((s) => s.place !== undefined).map((s) => [sectionKey(s), asPlace(s.place)!]));
    // The same board as it was stored before v1.02, and as the pin button
    // leaves it until the next render: the pinned sections are where he put
    // them, and no place is written on them yet.
    const asBefore: LayoutPlan = { ...withPlaces, sections: withPlaces.sections.map((s) => ({ component: s.component, ...(s.props ? { props: s.props } : {}), ...(s.why ? { why: s.why } : {}) })) };
    const stored = withPlaces;

    it.each(pins.length ? CHANGES : [])("stored before v1.02, with no place written on what he pinned: %s", async (_change, change) => {
      const after = (path.today ?? ((s) => s))(changed(before, change));
      const preferences = path.preferences ?? [];
      const res = await path.render(after, asBefore, pinnedKeys, preferences);
      clearPlanCache(); // the second render is its own, not the first one's planner answer from memory
      const withPlace = await path.render(after, withPlaces, pinnedKeys, preferences);
      // Read from where each pinned section stands, it is the same board, and the place is written from now on.
      expect(keys(res.plan)).toEqual(keys(withPlace.plan));
      expect(res.source).toBe(withPlace.source);
      for (const s of res.plan.sections) if (pinnedKeys.includes(sectionKey(s))) expect(s.place, sectionKey(s)).toEqual(places.get(sectionKey(s)));
    });

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
      // 2. Nothing else is where it is because of his pins: take them out of
      // both boards, and the rest is the board with nothing pinned.
      // Both at once, exactly: the board with nothing pinned, with what he
      // placed put in by the rule (top-counted in place order, then
      // bottom-counted from the end, none in front of one already put in).
      const body = shown.filter((k) => k !== "focus_banner");
      for (const key of pinnedKeys) if (!here.includes(key)) expect(shown, key).not.toContain(key);
      const without = (list: string[]) => list.filter((k) => !pinnedKeys.includes(k));
      expect(without(shown)).toEqual(without(keys(bare.plan)));
      expect(body).toEqual(placeInto(without(keys(bare.plan)).filter((k) => k !== "focus_banner"), here.map((key) => ({ key, ...places.get(key)! }))));
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
      for (const key of here) expect(res.plan.sections.find((s) => sectionKey(s) === key)?.place, key).toEqual(places.get(key));
    });

    // The stored plan still has everything where he put it; he lets go of all of it.
    if (pins.length) {
      it.each(CHANGES)("then he unpins: %s", async (_change, change) => {
        const after = (path.today ?? ((s) => s))(changed(before, change));
        const preferences = path.preferences ?? [];
        const res = await path.render(after, stored, [], preferences);
        const bare = await path.render(after, base, [], preferences);
        const shown = keys(res.plan);
        // A card he let go follows the data again: every card is in data order.
        expect(cardKeys(res.plan)).toEqual(cardKeys(defaultPlan(after)));
        // Another section goes back where the system has it: the board is the
        // one with nothing pinned. (Round 4 kept such a section at the place
        // stored with it, "a stated limit, until 1.06"; that rule is gone on
        // purpose: a place written on a section that is no longer his is not
        // read.)
        // One case apart: the strip, which rule 3 had sent up and which is
        // held there once the talk stops. While it was his, the stored board
        // did not have it as the system's, so "where the system has it" is
        // its default place (where a held or a planner's order had it comes
        // back with the storage split).
        const wasHeld = path.source === "previous" && path.name.includes("rule 3") && pinnedKeys.includes("timeline");
        expect(shown).toEqual(wasHeld ? keys(compose(planFromRules(after), after, null, [], preferences)) : keys(bare.plan));
        expect(new Set(shown).size).toBe(shown.length);
      });
    }
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
    const placed = placedKeys(listOnTop, ["project_card:shopping"], [], signals);
    expect([...placed]).toEqual(["project_card:shopping"]);
    expect(runPlace(ownSections(listOnTop.sections, placed))).toBe(3); // after next up, the tiles and the strip
    // Let go of, it is still on top of the stored plan, carrying its place: it still does not say.
    expect(runPlace(ownSections(listOnTop.sections, new Set()))).toBe(3);
    // A card on top that nobody placed is the system's first card. Round 4
    // let it say "the run starts here", above everything. The run is never
    // above next up or the tiles: bounded, it lands right under the tiles.
    const bare = { ...listOnTop, sections: listOnTop.sections.map((s) => ({ component: s.component, props: s.props })) };
    expect(runPlace(ownSections(bare.sections, new Set()))).toBe(2);
    // Cards listed last of all: the run stops above Needs a date and People.
    const others = plan.sections.filter((s) => s.component !== "project_card");
    const cards = plan.sections.filter((s) => s.component === "project_card");
    expect(runPlace([...others, ...cards])).toBe(3);
    // Each of next up and the tiles bounds it on its own: whichever stands lower.
    expect(runPlace([cards[0], others[1], others[0], ...others.slice(2), ...cards.slice(1)])).toBe(2);
    expect(runPlace([cards[0], others[0], ...others.slice(2), ...cards.slice(1)])).toBe(1); // the tiles are his: next up alone
    expect(runPlace([cards[0], others[1], ...others.slice(2), ...cards.slice(1)])).toBe(1); // next up is his: the tiles alone
    // A plan with no card of its own: after next up, the tiles and the strip, and still above Needs a date.
    expect(runPlace(others)).toBe(3);
    expect(runPlace([others[3], others[0], others[1], others[2], others[4]])).toBe(4); // Needs a date raised: top wins
  });

  describe("the right way up, whatever the system's plan says", () => {
    // The shape main's planner wrote: a banner, two urgent cards above next
    // up, the rest under the strip. Read as "the run starts at the first
    // card", it put every card above next up.
    const cards = plan.sections.filter((s) => s.component === "project_card");
    const rest = plan.sections.filter((s) => s.component !== "project_card");
    // (With the section retired since, which main still stored: it is on no board this version composes.)
    const fromMain: LayoutPlan = { plan_id: "plan-old", reason_summary: "A busy week", sections: [BANNER, ...cards.slice(0, 2), ...rest.slice(0, 3), ...cards.slice(2), { component: "open_loops" }, ...rest.slice(3)] };
    const run = cardKeys(defaultPlan(signals));
    // Bounded, the run lands right under the tiles, above the strip.
    const bounded = ["hero_next_up", "stat_row", ...run, "timeline", "date_chase", "people_index"];
    const answer = (sections: PlanSection[]) =>
      planWithFallback(signals, { previousPlan: compose(plan, signals, null, []), preferences: [], pinnedSections: [], llmEnabled: true, call: async () => JSON.stringify({ plan_id: "p", reason_summary: null, sections }) });

    it("a row main wrote, served again for the same signals: next up, the tiles, every card by the data, the strip", () => {
      expect(keys(compose(fromMain, signals, fromMain, []))).toEqual(["focus_banner", ...bounded]);
    });

    it("the same row held on the day this version lands (its banner is hours old, so the rules plan is refused today)", async () => {
      const today = structuredClone(signals);
      today.context.sections_new_today = ["focus_banner"];
      const held = await planWithFallback(today, { previousPlan: fromMain, preferences: [], pinnedSections: [], llmEnabled: false });
      expect(held.source).toBe("previous");
      expect(keys(held.plan)).toEqual(["focus_banner", ...bounded]);
    });

    it.each([
      ["main's shape, the cards in two runs", [...cards.slice(0, 2), ...rest.slice(0, 3), ...cards.slice(2), ...rest.slice(3)], bounded],
      ["every card first", [...cards, ...rest], bounded],
      ["one card first and the others last of all", [cards[0], ...rest, ...cards.slice(1)], bounded],
      ["every card last of all: above Needs a date and People", [...rest, ...cards], ["hero_next_up", "stat_row", "timeline", ...run, "date_chase", "people_index"]],
    ])("a planner's answer under this version: %s", async (_what, sections, expected) => {
      clearPlanCache();
      const res = await answer(sections);
      expect(res.source).toBe("llm");
      expect(keys(res.plan)).toEqual(expected);
    });

    it("a crossing: a planner may raise Needs a date above next up, or sink the tiles to the bottom; the run stays as near as it can to where the plan had it", async () => {
      const chase: PlanSection = { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" };
      const tiles: PlanSection = { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };
      const [hero, , strip, , people] = rest;
      const shown = async (sections: PlanSection[]) => {
        clearPlanCache();
        const res = await answer(sections);
        expect(res.source).toBe("llm");
        return keys(res.plan);
      };
      // Needs a date raised: the cards first, and last.
      expect(await shown([chase, ...cards, hero, rest[1], strip, people])).toEqual(["date_chase", "hero_next_up", "stat_row", ...run, "timeline", "people_index"]);
      expect(await shown([chase, hero, rest[1], strip, people, ...cards])).toEqual(["date_chase", "hero_next_up", "stat_row", "timeline", ...run, "people_index"]);
      // The tiles sunk to the bottom: the cards where they were are left alone (the first form of the bound moved them under the tiles).
      expect(await shown([hero, strip, ...cards, rest[3], people, tiles])).toEqual(["hero_next_up", "timeline", ...run, "date_chase", "people_index", "stat_row"]);
      expect(await shown([...cards, hero, strip, rest[3], people, tiles])).toEqual(["hero_next_up", ...run, "timeline", "date_chase", "people_index", "stat_row"]);
      expect(await shown([hero, strip, rest[3], people, tiles, ...cards])).toEqual(["hero_next_up", "timeline", ...run, "date_chase", "people_index", "stat_row"]);
    });

    it("what he hid or banned is not counted, so the board that is stored composes to itself: the tiles sunk by a planner, Needs a date and People hidden", () => {
      // The Reviewer's seed (31415926) found it: with the hidden sections
      // counted, the cards stayed above the sunk tiles at this render (a
      // place with a count of 1 was the best there was), and went under
      // them at the next, when the stored board no longer had the two.
      const tiles: PlanSection = { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };
      const sunk: LayoutPlan = { plan_id: "llm-x", reason_summary: null, sections: [rest[0], rest[2], ...cards, rest[3], rest[4], tiles] };
      const hidden: LayoutPreference[] = [{ kind: "hide_section", value: { section: "date_chase" } }, { kind: "hide_section", value: { section: "people_index" } }];
      const once = compose(sunk, signals, null, [], hidden);
      expect(keys(once)).toEqual(["hero_next_up", "timeline", "stat_row", ...run]);
      expect(keys(compose(once, signals, once, [], hidden))).toEqual(keys(once));
      // A section that still carries a place and is no longer his is not where the system has it either: it is drawn at its default place.
      const letGo: LayoutPlan = { ...sunk, sections: sunk.sections.map((s) => (s.component === "stat_row" ? { ...s, place: { from: "bottom", n: 0 } } : s)) };
      expect(keys(compose(letGo, signals, letGo, []))).toEqual(["hero_next_up", "stat_row", "timeline", ...run, "date_chase", "people_index"]);
    });

    describe("a hidden section is not counted, and the run does not land one off for it: each board composed twice", () => {
      // The place is worked out, and the board cut, on the same list: the
      // sections that will be drawn. A hidden one above where the cards go
      // (next up, the strip) or below (Needs a date) shifts nothing.
      const tiles: PlanSection = { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };
      const [H, , T, D, P] = rest;
      const PLANS: [string, PlanSection[], Record<string, string[]>][] = [
        [
          "the usual order",
          plan.sections,
          {
            hero_next_up: ["stat_row", "timeline", "cards", "date_chase", "people_index"],
            timeline: ["hero_next_up", "stat_row", "cards", "date_chase", "people_index"],
            date_chase: ["hero_next_up", "stat_row", "timeline", "cards", "people_index"],
          },
        ],
        [
          "the usual order, the plan's cards first",
          [...cards, ...rest],
          {
            hero_next_up: ["stat_row", "cards", "timeline", "date_chase", "people_index"],
            timeline: ["hero_next_up", "stat_row", "cards", "date_chase", "people_index"],
            date_chase: ["hero_next_up", "stat_row", "cards", "timeline", "people_index"],
          },
        ],
        [
          "crossed: a planner sank the tiles to the bottom",
          [H, T, ...cards, D, P, tiles],
          {
            hero_next_up: ["timeline", "cards", "date_chase", "people_index", "stat_row"],
            timeline: ["hero_next_up", "cards", "date_chase", "people_index", "stat_row"],
            date_chase: ["hero_next_up", "timeline", "cards", "people_index", "stat_row"],
          },
        ],
      ];
      describe.each(PLANS)("%s", (_name, sections, expected) => {
        it.each(Object.keys(expected))("with %s hidden", (hiddenKey) => {
          const system: LayoutPlan = { plan_id: "llm-x", reason_summary: null, sections };
          const preferences: LayoutPreference[] = [{ kind: "hide_section", value: { section: hiddenKey } }];
          const once = compose(system, signals, null, [], preferences);
          expect(keys(once)).toEqual(expected[hiddenKey].flatMap((k) => (k === "cards" ? run : [k])));
          expect(keys(compose(once, signals, once, [], preferences))).toEqual(keys(once));
        });
      });
    });

    it("the system's own order may have the run right under the tiles, the strip below it (main's default)", () => {
      const mains: LayoutPlan = { plan_id: "plan-old", reason_summary: null, sections: [...rest.slice(0, 2), ...cards, ...rest.slice(2)] };
      expect(keys(compose(mains, signals, mains, []))).toEqual(bounded);
    });

    it("'the system's' is each section on its own: next up placed by him at the bottom, hidden or banned, bounds nothing; the tiles still do", () => {
      const his = pinned(plan, { key: "hero_next_up", at: () => "last" });
      expect(keys(compose(fromMain, signals, his, ["hero_next_up"]))).toEqual(["focus_banner", "stat_row", ...run, "timeline", "date_chase", "people_index", "hero_next_up"]);
      for (const preference of [{ kind: "hide_section", value: { section: "hero_next_up" } }, { kind: "ban_component", value: { component: "hero_next_up" } }] as LayoutPreference[]) {
        expect(keys(compose(fromMain, signals, fromMain, [], [preference]))).toEqual(["focus_banner", ...bounded.filter((k) => k !== "hero_next_up")]);
      }
      // Both his: nothing of the system's stands above, and a plan with its cards first has them first.
      expect(runPlace([...cards, ...rest.slice(2)])).toBe(0);
    });

    it("what he placed on a row main wrote is his, and untouched: a card he put above next up stays there, at the place read off that row", () => {
      // main kept his pins as keys on the row, with no place written.
      const hisCard = sectionKey(cards[0]);
      const before = compose(fromMain, signals, fromMain, [hisCard]);
      expect(keys(before).slice(0, 3)).toEqual(["focus_banner", hisCard, "hero_next_up"]);
      expect(before.sections[1].place).toEqual({ from: "top", n: 0 });
      // The system's cards, the one that stood beside it included, are the run under the tiles.
      expect(keys(before).slice(3)).toEqual(["stat_row", ...run.filter((k) => k !== hisCard), "timeline", "date_chase", "people_index"]);
    });

    it("a place read off a row main wrote does not count the section retired since: his strip, and a Needs a date he moved up one, land where he had them", () => {
      // main's own order: next up, the tiles, the cards, the strip, the retired section, Needs a date, People.
      const retired: PlanSection = { component: "open_loops" };
      const mains = (sections: PlanSection[]): LayoutPlan => ({ plan_id: "user-old", reason_summary: null, sections });
      // He pinned the strip where it stood: under the last card.
      const strip = mains([...rest.slice(0, 2), ...cards, rest[2], retired, ...rest.slice(3)]);
      const withStrip = keys(compose(defaultPlan(signals), signals, strip, ["timeline"]));
      expect(withStrip.slice(-3)).toEqual(["timeline", "date_chase", "people_index"]);
      expect(withStrip.indexOf("timeline")).toBe(withStrip.findLastIndex(isCard) + 1);
      // He moved Needs a date up one, above the retired section.
      const chase = mains([...rest.slice(0, 2), ...cards, rest[2], rest[3], retired, rest[4]]);
      const withChase = keys(compose(defaultPlan(signals), signals, chase, ["date_chase"]));
      expect(withChase.slice(-2)).toEqual(["date_chase", "people_index"]);
      expect(withChase.indexOf("date_chase")).toBe(withChase.findLastIndex(isCard) + 1);
    });
  });

  it("the banner is first whatever a request did above it", () => {
    const withBanner = [BANNER, ...plan.sections];
    expect(bannerFirst(withBanner)).toBe(withBanner);
    const pushed = [plan.sections[0], BANNER, ...plan.sections.slice(1)];
    expect(bannerFirst(pushed).map(sectionKey)).toEqual(withBanner.map(sectionKey));
    expect(bannerFirst(plan.sections)).toBe(plan.sections);
  });

  it("a plan with no card of its own has the run under the strip, wherever the strip is", () => {
    const none = plan.sections.filter((s) => s.component !== "project_card");
    expect(runPlace(none)).toBe(3);
    expect(runPlace([none[2], none[0], none[1], ...none.slice(3)])).toBe(3);
    expect(runPlace(none.filter((s) => s.component !== "timeline"))).toBe(2);
    expect(runPlace([])).toBe(0);
  });

  it("a pin that is not on the stored plan places nothing", () => {
    expect([...placedKeys(plan, ["kanban"], [{ kind: "pin_section", value: { section: "documents" } }], signals)]).toEqual([]);
    expect([...placedKeys(null, ["stat_row"], [], signals)]).toEqual([]);
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

  it("a committed date already past says how late it is, and the count is today's when the plan is served again", () => {
    // (Until now only the chip test in the walker's file held these two: the wording, and that it is read back as a counted reason.)
    const late = (days: number) => ({ ...morning().projects[0], deadline_type: "committed" as const, deadline_days: days });
    expect(deadlineWhy(late(-3))).toBe("3 days late — you committed to this date");
    expect(deadlineWhy(late(-1))).toBe("1 day late — you committed to this date");
    expect(deadlineWhy(late(0))).toBe("Due today — you committed to this date");
    expect(isDeadlineWhy("3 days late")).toBe(true);
    expect(isDeadlineWhy("1 day late — you committed to this date")).toBe(true);
    const signals = morning();
    signals.projects = [late(-3), signals.projects[1]];
    const base = compose(planFromRules(evening()), evening(), null, []);
    const stale: LayoutPlan = { ...base, sections: base.sections.map((s) => (s.props?.project_id === "report" ? { ...s, why: "2 days late — you committed to this date" } : s)) };
    expect(whyOf(compose(stale, signals, stale, []))).toBe("3 days late — you committed to this date");
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
