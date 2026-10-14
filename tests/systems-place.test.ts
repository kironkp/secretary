// SPEC §2 (v1.02 r5): where a section of the system's goes on a list that
// lacks it. One rule decides it, for a board being composed and for a request
// that brings a section back:
//   it takes its place in the first order the rules can produce that is
//   accepted against the list as it stands, the clock a day on (the usual
//   order first, then the strip sent up). If none is accepted, it goes by
//   today's order, and a tie is read against the section that carries a
//   reason on the board, or else one the rules can move.
// The functions are small and pure, so they are asked about every case there
// is, and judged by nothing of their own:
//   1. the place in an order (systemsPlace), by this file's own reading of
//      "in step" (every run tried, the longest kept, of two equally long the
//      one that ends latest in the plan's order): directly under the last
//      section in step that precedes it; with none, directly above the first
//      that follows it; with neither, first. And by length alone, no tie
//      read: with the section in, the longest run in step is one longer;
//   2. the rule as a whole (withSystems), by the validator (movementReasons,
//      the product's judge of a system plan): no order the rules can produce
//      that was accepted against the list is refused against it with the
//      section in. For the order the place was taken from that is how the
//      place is made; for the OTHER order it rests on the validator's reading
//      of a tie, which a test here pins by name, with the boards it decides;
//   3. a planner's plan as the order: every order that moves one or two
//      sections, each with a reason: accepted before, accepted after.
// Then the cases worked by hand in the contract, as boards written out.
import { describe, expect, it } from "vitest";
import { acceptedOrders, composePlan, systemsPlace, todaysOrder, withSystems } from "@/lib/layout/compose";
import { inStep as validatorsReading } from "@/lib/layout/in-step";
import { defaultPlan, sectionKey, type LayoutPlan, type Place, type PlanSection } from "@/lib/layout/plan";
import { planWithFallback } from "@/lib/layout/plan-from-llm";
import { movementReasons, type LayoutPreference } from "@/lib/layout/validator";
import type { Signals } from "@/lib/layout/signals";
import { baseSignals } from "./fixtures/layout";

const FIVE = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const STRIP_UP = ["timeline", "hero_next_up", "stat_row", "date_chase", "people_index"];
const section = (component: string): PlanSection => ({ component });
const reason = (component: string): PlanSection => ({ component, why: "A reason on the board" });
const card = (id: string): PlanSection => ({ component: "project_card", props: { project_id: id, variant: "full" } });

function orders(list: string[]): string[][] {
  if (!list.length) return [[]];
  return list.flatMap((first, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [first, ...rest]));
}
const subsets = (list: string[]) => Array.from({ length: 1 << list.length }, (_, mask) => list.filter((_, i) => mask & (1 << i)));

/** Every run of `list` that stands in the same order in `order`. */
const runs = (list: string[], order: string[]) => subsets(list).filter((run) => run.every((k, i) => i === 0 || order.indexOf(run[i - 1]) < order.indexOf(k)));
/** Of several runs, the one that ends latest in `order`, then the one whose section before that stands latest, and so on. */
function latest(candidates: string[][], order: string[]): string[] {
  const from = (run: string[]) => run.map((k) => order.indexOf(k)).toSorted((a, b) => b - a);
  return candidates.reduce((best, run) => {
    const [x, y] = [from(run), from(best)];
    const i = x.findIndex((n, j) => n !== y[j]);
    return i !== -1 && x[i] > y[i] ? run : best;
  });
}
const longest = (list: string[], order: string[]) => Math.max(...runs(list, order).map((run) => run.length));
const longestRuns = (list: string[], order: string[]) => runs(list, order).filter((run) => run.length === longest(list, order));
/** This file's own reading of "in step": the longest run; of two equally long, the one that ends latest in the plan's order. */
const inStep = (list: string[], order: string[]) => latest(longestRuns(list, order), order);
/**
 * And of a tie on a held list: a section could be read as the one out of step when some longest run stands without
 * it. First the sections that carry a reason, then the ones the rules can move (the strip): if there are any of the
 * kind that could be read so, the longest runs without all of them; if there is no such run (both sections of the
 * tie are of that kind), the plain reading.
 */
function inStepHeld(list: string[], order: string[], reasoned: string[]): string[] {
  const all = longestRuns(list, order);
  for (const likely of [reasoned, ["timeline"]]) {
    const could = likely.filter((k) => list.includes(k) && all.some((run) => !run.includes(k)));
    if (!could.length) continue;
    const without = all.filter((run) => could.every((k) => !run.includes(k)));
    return latest(without.length ? without : all, order);
  }
  return latest(all, order);
}
function expected(list: string[], key: string, order: string[], held?: { reasoned: string[] }): number {
  const kept = held ? inStepHeld(list, order, held.reasoned) : inStep(list, order);
  const here = order.indexOf(key);
  const above = order.slice(0, here).findLast((k) => kept.includes(k));
  if (above) return list.indexOf(above) + 1;
  const below = order.slice(here + 1).find((k) => kept.includes(k));
  return below ? list.indexOf(below) : 0;
}
const put = (list: string[], key: string, at: number) => [...list.slice(0, at), key, ...list.slice(at)];

describe("the place in an order: every order, every list order of every subset", () => {
  it("directly under the last section in step that precedes it, else directly above the first that follows it; and it joins the run (39,000 cases)", { timeout: 120_000 }, () => {
    let cases = 0;
    for (const order of orders(FIVE)) {
      for (const key of FIVE) {
        for (const subset of subsets(FIVE.filter((k) => k !== key))) {
          for (const list of orders(subset)) {
            const at = systemsPlace(list.map(section), key, new Set(), order);
            const what = `the order ${order.join(" ")}; the list ${list.join(" ") || "(nothing)"}; ${key} comes back`;
            expect(at, what).toBe(expected(list, key, order));
            expect(longest(put(list, key, at), order), `${what}: it joins the run in step`).toBe(longest(list, order) + 1);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(39_000);
  });

  it("the cards, the banner and what he placed are never asked which section is in step; and the run of cards counts as a section of the order", () => {
    const kanban = section("kanban");
    const his = new Set(["kanban", "stat_row"]);
    const UPPER = [H, S, T];
    for (const order of [FIVE, STRIP_UP]) {
      for (const key of FIVE.filter((k) => k !== "stat_row")) {
        for (const subset of subsets(FIVE.filter((k) => k !== key && k !== "stat_row"))) {
          for (const systems of orders(subset)) {
            // A banner, then his kanban, then each of the system's sections with a card after it, and the tiles (his) last.
            const list = [section("focus_banner"), kanban, ...systems.flatMap((k, i) => [section(k), card(`c${i}`)]), section("stat_row")];
            const upper = UPPER.includes(key);
            const at = systemsPlace(list, key, his, order, false, upper);
            const want = expected(systems, key, order);
            const [above, below] = [systems[want - 1], systems[want]];
            const index = (k: string) => list.findIndex((s) => s.component === k);
            const kept = inStep(systems, order);
            const saysAbove = order.slice(0, order.indexOf(key)).some((k) => kept.includes(k));
            const [firstCard, lastCard] = [list.findIndex((s) => s.component === "project_card"), list.findLastIndex((s) => s.component === "project_card")];
            const what = `${order.join(" ")} | ${systems.join(" ")} | ${key}`;
            // Needs a date and People have the cards above them: behind the last card, which here stands under every
            // section of the system's. Next up and the strip have the cards below them: under their section in step
            // when there is one above, but never below the first card (which here stands under the first section
            // only); else above the first in step that follows AND in front of the first card.
            // With nothing of the system's: first under the banner.
            if (!systems.length) expect(at, what).toBe(1);
            else if (!upper) expect(at, what).toBe(lastCard + 1);
            else if (saysAbove) expect(at, what).toBe(Math.min(index(above) + 1, firstCard));
            else expect(at, what).toBe(Math.min(below ? index(below) : Infinity, firstCard));
          }
        }
      }
    }
  });

  it("with nothing of the system's on the list but cards: in front of them, or behind them; with nothing of the system's at all, first under the banner", () => {
    const his = new Set(["kanban"]);
    const onlyCards = [section("focus_banner"), section("kanban"), card("a"), card("b")];
    expect(systemsPlace(onlyCards, T, his, FIVE, false, true)).toBe(2); // the strip: in front of the cards
    expect(systemsPlace(onlyCards, D, his, FIVE, false, false)).toBe(4); // Needs a date: behind them
    expect(systemsPlace([section("focus_banner"), section("kanban")], D, his, FIVE, false, false)).toBe(1);
    expect(systemsPlace([section("kanban")], D, his, FIVE, false, false)).toBe(0);
    expect(systemsPlace([], D, his, FIVE, false, false)).toBe(0);
    // No cards, and a section a planner added that is in no order of the rules: in front of that.
    expect(systemsPlace([section("focus_banner"), section("kanban"), section("coming_up")], D, his, FIVE, false, false)).toBe(2);
  });

  it("the run of cards as a section of the order, case by case: Needs a date behind the cards and under its section in step, whichever is lower; the strip in front of the cards and above what follows it, whichever is higher; and the side of the cards wins both ways", () => {
    const [a, b, c] = [card("a"), card("b"), card("c")];
    const his = new Set([sectionKey(b), "kanban"]);
    // next up, the tiles, the strip, card, HIS card, his kanban, card, People: Needs a date comes back after the last of the system's cards.
    const list = [section(H), section(S), section(T), a, b, section("kanban"), c, section(P)];
    expect(systemsPlace(list, D, his, FIVE, false, false)).toBe(7);
    // The same list, a section that belongs in front of the cards coming back under the tiles: directly under them.
    expect(systemsPlace(list.filter((x) => x.component !== T), T, his, FIVE, false, true)).toBe(2);
    // No cards between the strip and People (they all stand above the strip): Needs a date directly under the strip.
    expect(systemsPlace([section(H), section(S), a, c, section(T), section(P)], D, his, FIVE, false, false)).toBe(5);
    // What he placed stands under the last card: Needs a date goes behind the cards, not behind that.
    expect(systemsPlace([section(T), a, c, section("kanban"), section(P)], D, his, FIVE, false, false)).toBe(3);
    // Nothing in step above the strip: in front of the cards that stand above Needs a date, and of his card among them.
    expect(systemsPlace([a, b, c, section(D), section(P)], T, his, FIVE, false, true)).toBe(0);
    // And a section that has the cards above it, with nothing in step above it: behind the cards.
    expect(systemsPlace([a, b, c, section(P)], D, his, FIVE, false, false)).toBe(3);
    // Where its section in step and its side of the cards cannot both hold, the side of the cards wins. A planner
    // has the tiles above next up, the cards under both: Needs a date goes behind the cards, not between the two
    // (the Reviewer's board for the two readings).
    expect(systemsPlace([section(S), section(H), a, c], D, new Set(), FIVE, true, false)).toBe(4);
    // The other way round. Next up has the cards below it, and its section in step (the tiles, above it in this
    // order) stands under the cards: in front of the first card, not under the tiles. And the Planner's board: the
    // cards above the strip, the strip first in today's order; next up comes back in front of the cards.
    expect(systemsPlace([a, c, section(S), section(T)], H, new Set(), [S, H, T, D, P], false, true)).toBe(0);
    expect(systemsPlace([a, b, c, section(T), section(P), section(D)], H, his, [T, H, S, D, P], true, true)).toBe(0);
    // With its section in step above the cards, under that section as ever.
    expect(systemsPlace([section(T), a, b, c, section(P)], H, his, [T, H, S, D, P], false, true)).toBe(1);
    // A card he placed is not one of the run. With his card first, the strip goes in front of the first card that
    // is the system's, behind his; with his card last, Needs a date goes behind the last that is, in front of his.
    expect(systemsPlace([b, a, c, section(D)], T, his, FIVE, false, true)).toBe(1);
    expect(systemsPlace([section(H), a, c, b], D, his, FIVE, false, false)).toBe(3);
    // All three kinds (the Reviewer's count: next up 72, the tiles 146, the strip 45, every one on a list no order
    // is accepted against). A planner has Needs a date, with its reason, and one section in step under the cards;
    // each of the other two comes back in front of the first card, not under that section.
    const raised = { ...section(D), why: "Several things have no date" };
    for (const [under, back, order] of [
      [T, H, [T, H, S, D, P]],
      [H, S, FIVE],
      [T, S, [T, H, S, D, P]],
      [H, T, FIVE],
      [S, T, FIVE],
    ] as const) {
      const list = [a, b, c, raised, section(under)];
      expect(systemsPlace(list, back, his, [...order], true, true), `${back} with ${under} under the cards`).toBe(0);
      // (Without the cards it goes under that section: the section is in step, and precedes it.)
      expect(systemsPlace([raised, section(under)], back, his, [...order], true, true), `${back} with ${under} and no cards`).toBe(2);
    }
  });
});

describe("a tie on a list no order of the rules is accepted against (today's order decides, and a likelier section is read as moved)", () => {
  const at = (list: PlanSection[], key: string, held: boolean) => systemsPlace(list, key, new Set(), FIVE, held);

  it("one of the two carries a reason on the board (a planner's raised Needs a date against next up): it is the one read as moved", () => {
    const list = [reason("date_chase"), section("hero_next_up")];
    expect(at(list, "stat_row", true)).toBe(2); // under next up
    expect(at(list, "stat_row", false)).toBe(0); // the validator's reading: above Needs a date, on top of the board
  });

  it("neither carries a reason and one is the strip, which the rules can move: the strip is the one read as moved", () => {
    const list = ["timeline", "hero_next_up", "date_chase", "people_index"].map(section);
    expect(at(list, "stat_row", true)).toBe(2); // under next up
    expect(at(list, "stat_row", false)).toBe(0); // the validator's reading: next up moved, the tiles above the strip
    const noTiles = ["timeline", "stat_row", "date_chase", "people_index"].map(section);
    expect(at(noTiles, "hero_next_up", true)).toBe(1); // under the strip, above the tiles
    expect(at(noTiles, "hero_next_up", false)).toBe(0);
  });

  it("one carries a reason and the other is the strip, which carries none: the reason is read first", () => {
    const list = [reason("date_chase"), section("timeline")];
    expect(at(list, "people_index", true)).toBe(2); // Needs a date is the one read as moved: People under the strip
    expect(at(list, "people_index", false)).toBe(1); // the validator's reading keeps Needs a date, the later of the two in today's order
  });

  it("both carry a reason (the strip a rule opened, and a planner's raised Needs a date): the validator's reading stands", () => {
    const list = [reason("date_chase"), reason("timeline")];
    expect(at(list, "people_index", true)).toBe(1);
    expect(at(list, "people_index", false)).toBe(1);
  });

  it("neither is of either kind (next up and the tiles swapped, no reason on either): the validator's reading stands", () => {
    const list = ["stat_row", "hero_next_up"].map(section);
    expect(at(list, "timeline", true)).toBe(1); // under the tiles, the later of the two in today's order
    expect(at(list, "timeline", false)).toBe(1);
  });

  it("a section with a reason that is in step in every reading is left where it is: only the one in the tie is read as moved", () => {
    // Needs a date against next up again, and People, in step either way, carries a reason too.
    const list = [reason("date_chase"), section("hero_next_up"), reason("people_index")];
    expect(at(list, "stat_row", true)).toBe(2);
    expect(at(list, "stat_row", false)).toBe(0);
  });

  // An explicit ceiling, like spend-cuts': 4,890 cases ran 5.8 s once on a loaded machine and hit vitest's 5 s default.
  it("every list, for the two orders the rules can produce, with a reason on none, one or two of its sections: this file's own reading (4,890 cases)", { timeout: 30_000 }, () => {
    let [cases, differs] = [0, 0];
    for (const order of [FIVE, STRIP_UP]) {
      for (const key of FIVE) {
        for (const subset of subsets(FIVE.filter((k) => k !== key))) {
          for (const list of orders(subset)) {
            for (const reasons of subsets(list).filter((r) => r.length <= 2)) {
              const got = systemsPlace(list.map((k) => (reasons.includes(k) ? reason(k) : section(k))), key, new Set(), order, true);
              expect(got, `${order.join(" ")} | ${list.join(" ")} | reasons on ${reasons.join(" ") || "none"} | ${key}`).toBe(expected(list, key, order, { reasoned: reasons }));
              if (got !== expected(list, key, order)) differs++;
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(4890);
    // In some of them the tie is read otherwise than the validator would: the sentence does something.
    expect(differs).toBeGreaterThan(100);
  });
});

// --- the validator as the judge ---------------------------------------------------------
const signalsAt = (days: number): Signals => {
  const signals = baseSignals();
  signals.context.days_since_layout_change = days;
  signals.context.sections_new_today = [];
  return signals;
};
const planOf = (id: string, order: string[], why: string[] = []): LayoutPlan => ({ plan_id: id, reason_summary: null, sections: order.map((c) => ({ component: c, ...(why.includes(c) ? { why: "A reason for the move" } : {}) })) });
/** Whether a plan (its order, with a reason on `why`) is refused against a stored board, `days` after the layout last changed. */
const refused = (board: string[], today: string[], why: string[], days: number) => {
  const signals = signalsAt(days);
  return movementReasons(planOf("today", today, why), { signals, previousPlan: planOf("stored", board), preferences: [], pinnedSections: [], defaultPlan: defaultPlan(signals) }).length > 0;
};
const quiet = (): Signals => signalsAt(2);
/** He has asked about dates all day: a day or more after the layout last changed the rules send the strip up; the same day they may not. */
const datesAllDay = (days = 2): Signals => {
  const signals = signalsAt(days);
  signals.conversation.schedule_word_share = 0.5;
  return signals;
};
/** The two orders the rules can produce, as this file states them, and whether each is accepted against a list (a day on). */
const RULES_ORDERS: { name: string; order: string[]; why: string[] }[] = [
  { name: "the usual order", order: FIVE, why: [] },
  { name: "the strip sent up", order: STRIP_UP, why: ["timeline"] },
];
const acceptedBy = (list: string[]) => RULES_ORDERS.filter((o) => !refused(list, o.order.filter((k) => list.includes(k)), o.why, 2)).map((o) => o.name);
const [H, S, T, D, P] = FIVE;

describe("the rule as a whole: the validator is the judge", () => {
  it("the product's own list of the orders the rules can produce, and which are accepted, is this file's", () => {
    for (const signals of [quiet(), datesAllDay(), datesAllDay(0)]) {
      for (const subset of subsets(FIVE)) {
        for (const list of orders(subset)) {
          const got = acceptedOrders(planOf("stored", list), [], [], signals).map((order) => order.join());
          expect(got, list.join(" ")).toEqual(RULES_ORDERS.filter((o) => acceptedBy(list).includes(o.name)).map((o) => o.order.join()));
        }
      }
    }
  });

  it("no order the rules can produce that was accepted against the list is refused against it with the section in (975 cases)", () => {
    // Every list x every section that can come back x three days: a quiet one, one on which a rule sends the strip
    // up, and the very day it did (today's order is the usual one again, the layout having changed today).
    let [cases, usualToo, stripOnly, none] = [0, 0, 0, 0];
    for (const signals of [quiet(), datesAllDay(), datesAllDay(0)]) {
      for (const key of FIVE) {
        for (const subset of subsets(FIVE.filter((k) => k !== key))) {
          for (const list of orders(subset)) {
            cases++;
            const before = acceptedBy(list);
            const after = withSystems(list.map(section), [section(key)], new Set(), signals).map(sectionKey);
            expect(after.filter((k) => k !== key), "everything else keeps its order").toEqual(list);
            const still = acceptedBy(after);
            expect(before.filter((name) => !still.includes(name)), `${list.join(" ") || "(nothing)"} + ${key} -> ${after.join(" ")}`).toEqual([]);
            if (before.join() === "the usual order,the strip sent up") usualToo++;
            else if (before.join() === "the strip sent up") stripOnly++;
            else if (!before.length) none++;
          }
        }
      }
    }
    // 325 lists on each of the three days. Against 80 of them the usual order is accepted, and then the strip sent up
    // is too; against 48 more only the strip sent up (the Reviewer's model: the same 128 of 325); against 197 neither,
    // and today's order decides.
    expect([cases, usualToo, stripOnly, none]).toEqual([975, 240, 144, 591]);
  });

  describe("the tie this rests on, pinned by name", () => {
    // Two sections tie: the one standing LATER on the stored board is read as moved. (One ">=" in the validator's
    // function says so; put the other way, the section standing earlier is read as moved.) The rule above rests on it
    // for the order the place was NOT taken from: a board in the usual order with exactly one of next up and the
    // tiles above the strip is accepted against "the strip sent up" only because the strip, standing later, is the
    // one read as moved, and the strip is the one that carries the reason.
    it("two sections tie: the one standing later on the stored board is read as moved", () => {
      expect([...validatorsReading([S, T], [T, S])]).toEqual([S]);
      expect([...validatorsReading([T, S], [S, T])]).toEqual([T]);
      expect([...validatorsReading([H, T, D, P], [T, H, D, P])].toSorted()).toEqual([H, D, P].toSorted());
    });

    it.each([[[H, T]], [[S, T]], [[H, T, D]], [[S, T, D]], [[H, T, S, D]], [[H, T, P]], [[S, T, P]], [[H, T, S, P]], [[H, T, D, P]], [[S, T, D, P]], [[H, T, S, D, P]]])("%j against the strip sent up: accepted, because the strip is the one read as moved", (stored) => {
      const plan = STRIP_UP.filter((k) => stored.includes(k));
      // More than one longest run: the verdict hangs on which is kept.
      expect(longestRuns(stored, plan).length).toBeGreaterThan(1);
      expect(refused(stored, plan, [T], 2)).toBe(false);
      // The reason on the section above the strip instead: refused. So it is the strip that was read as moved.
      expect(refused(stored, plan, [stored[0]], 2)).toBe(true);
    });
  });

  it("several sections put in one after the other: the order they are put in does not change where any of them goes (1,674 cases)", () => {
    // Every list, every two or more sections it lacks, by each order of the rules, with an order accepted and with
    // none (a reason on none or one of the list's sections): every sequence of putting them in gives one board.
    let cases = 0;
    for (const order of [FIVE, STRIP_UP]) {
      for (const held of [false, true]) {
        for (const missing of subsets(FIVE).filter((m) => m.length >= 2)) {
          for (const subset of subsets(FIVE.filter((k) => !missing.includes(k)))) {
            for (const list of orders(subset)) {
              for (const reasons of held ? subsets(list).filter((r) => r.length <= 1) : [[]]) {
                const boards = new Set<string>();
                for (const sequence of orders(missing)) {
                  let next = list.map((k) => (reasons.includes(k) ? reason(k) : section(k)));
                  for (const key of sequence) {
                    const at = systemsPlace(next, key, new Set(), order, held);
                    next = [...next.slice(0, at), section(key), ...next.slice(at)];
                  }
                  boards.add(next.map(sectionKey).join(" "));
                }
                expect([...boards], `${list.join(" ") || "(nothing)"} lacks ${missing.join(" ")}`).toHaveLength(1);
                cases++;
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(1674);
  });

  it("a planner's plan as the order: every order that moves one or two sections, each with a reason: accepted before, accepted after", { timeout: 120_000 }, () => {
    // A plan that moves one or two sections of the usual order, each with a reason: every order, with a reason on what it moved.
    const plans = new Map<string, { order: string[]; why: string[] }>();
    for (const order of orders(FIVE)) {
      for (const run of longestRuns(order, FIVE)) {
        const why = FIVE.filter((k) => !run.includes(k));
        if (why.length === 1 || why.length === 2) plans.set(`${order.join()}|${why.join()}`, { order, why });
      }
    }
    let [cases, acceptedBefore, heldAfter] = [0, 0, 0];
    for (const plan of plans.values()) {
      for (const days of [2, 0]) {
        for (const key of FIVE) {
          for (const subset of subsets(FIVE.filter((k) => k !== key))) {
            for (const list of orders(subset)) {
              cases++;
              const today = plan.order.filter((k) => list.includes(k));
              if (refused(list, today, plan.why, days)) continue;
              acceptedBefore++;
              const at = systemsPlace(list.map(section), key, new Set(), plan.order);
              if (refused(put(list, key, at), [...today, key].toSorted((a, b) => plan.order.indexOf(a) - plan.order.indexOf(b)), plan.why, days)) heldAfter++;
            }
          }
        }
      }
    }
    // 77 orders move one or two sections; some can be read two ways (which of two neighbours moved): 128 plans.
    expect([plans.size, cases, acceptedBefore]).toEqual([128, 83_200, 28_724]);
    expect(heldAfter).toBe(0);
  });

  it("the other end of the gap would not do: next to a section the plan is about to move, the plan is refused", () => {
    // The Reviewer's measured case. The strip's move up is waiting; next up comes back. Under the strip (its only
    // predecessor in the strip-up order, and the place the rule before this one gave), the tiles read as moved, with no reason.
    const list = [S, T, D, P];
    expect(refused(list, STRIP_UP.filter((k) => k !== H), [T], 2)).toBe(false);
    expect(refused(put(list, H, 0), STRIP_UP, [T], 2)).toBe(false);
    expect(refused(put(list, H, 2), STRIP_UP, [T], 2)).toBe(true);
  });
});

// --- the contract's cases, as boards written out -------------------------------------------
type Item = string | [string, Place] | PlanSection;
/** A stored board from its keys ("cards" is the run of cards, in data order; a pair is a section he placed, with its place; a whole section is itself). */
function board(signals: Signals, items: Item[]): { plan: LayoutPlan; pinned: string[] } {
  const cards = defaultPlan(signals).sections.filter((s) => s.component === "project_card");
  const sections = items.flatMap((item): PlanSection[] => (item === "cards" ? cards : typeof item === "string" ? [section(item)] : Array.isArray(item) ? [{ component: item[0], place: item[1] }] : [item]));
  return { plan: { plan_id: "stored", reason_summary: null, sections }, pinned: items.filter((i) => Array.isArray(i)).map((i) => i[0]) };
}
const hidden = (...keys: string[]): LayoutPreference[] => keys.map((key) => ({ kind: "hide_section", value: { section: key } }));
const short = (plan: LayoutPlan) => plan.sections.map((s) => (s.component === "project_card" ? "cards" : `${sectionKey(s)}${s.place !== undefined ? "*" : ""}`)).filter((k, i, all) => k !== "cards" || all[i - 1] !== "cards");
/** What the composition makes of a stored board that is served again: its keys, the run of cards as one word. */
function composed(signals: Signals, items: Item[], preferences: LayoutPreference[] = []): string[] {
  const { plan, pinned } = board(signals, items);
  return short(composePlan(plan, { signals, stored: plan, pinned, preferences }));
}
/** Which of the orders the rules can produce are accepted against a board as it stands. */
function accepted(signals: Signals, items: Item[], preferences: LayoutPreference[] = []): string[] {
  const { plan, pinned } = board(signals, items);
  return acceptedOrders(plan, pinned, preferences, signals).map((order) => (order.indexOf(T) === 0 && order.length > 1 ? "the strip sent up" : "the usual order"));
}
/** What a new open is served on a board as the stored one, on a day: the rules plan, or the board held. */
async function served(signals: Signals, items: Item[], preferences: LayoutPreference[] = []) {
  const { plan, pinned } = board(signals, items);
  const told = composePlan(plan, { signals, stored: plan, pinned, preferences });
  return (await planWithFallback(signals, { previousPlan: told, preferences, pinnedSections: pinned, llmEnabled: false })).source;
}
/** The strip as rule 3 leaves it: opened up, with its reason. */
const OPENED: PlanSection = { component: "timeline", props: { span_days: 14, expanded: true }, why: "You've been talking dates all day — the two weeks ahead, opened up" };
const USUAL = [H, S, T, "cards", D, P];
const BOTH = ["the usual order", "the strip sent up"];

describe("where a section goes on a list that lacks it: the boards, written out", () => {
  it("the orders these cases stand on", () => {
    expect(todaysOrder(quiet())).toEqual(FIVE);
    expect(todaysOrder(datesAllDay())).toEqual(STRIP_UP);
    expect(todaysOrder(datesAllDay(0))).toEqual(FIVE); // the layout changed today: the rules may not move the strip again
    const calm = datesAllDay();
    calm.context.calm_mode = true;
    expect(todaysOrder(calm)).toEqual(FIVE);
    // In calm mode no plan is asked for: the board is the default's, whatever stands on the list.
    expect(acceptedOrders(board(calm, [OPENED, H, "cards"]).plan, [], [], calm)).toEqual([FIVE]);
  });

  it("1. the strip under the cards, Needs a date comes back: under the strip (a seed of the Reviewer's, 16180339: it came back above it)", async () => {
    const before: Item[] = [H, S, "cards", T, P];
    expect(accepted(quiet(), before)).toEqual(BOTH);
    expect(composed(quiet(), before)).toEqual([H, S, "cards", T, D, P]);
    expect(await served(quiet(), before)).toBe("rules");
    // Above the strip, where 472c2a7 put it, the usual order is refused: today's rules plan, so the board is held.
    const wrong: Item[] = [H, S, "cards", D, T, P];
    expect(accepted(quiet(), wrong)).toEqual(["the strip sent up"]);
    expect(await served(quiet(), wrong)).toBe("previous");
  });

  it("2. on that board People comes back: under Needs a date", () => {
    expect(composed(quiet(), [H, S, "cards", T, D])).toEqual([H, S, "cards", T, D, P]);
  });

  it("3. Needs a date raised by a planner, next up his, People missing: no order of the rules is accepted; People under the strip, and the cards above it (seed 27182818)", () => {
    const before: Item[] = [D, [H, { from: "top", n: 1 }], S, T, "cards"];
    expect(accepted(quiet(), before)).toEqual([]);
    expect(composed(quiet(), before)).toEqual([D, `${H}*`, S, T, "cards", P]);
  });

  it("4. Needs a date raised, the plan's cards first, the tiles missing: the tiles in front of the cards, and no card moves (their section in step, next up, stands under the cards: the side of the cards wins)", () => {
    // (Until the side of the cards won both ways the tiles went under next up, under the cards, and the count then
    // moved every card under the tiles: Needs a date, next up, the tiles, the cards.)
    expect(composed(quiet(), ["cards", D, H, T, P])).toEqual([S, "cards", D, H, T, P]);
  });

  it("5. named, with 18: a rule has sent the strip up, next up is HIS, the tiles come back: above the strip", () => {
    // What he placed is not the system's: its list is the strip, Needs a date, People, which shows no move. The
    // usual order is accepted against it and stays accepted with the tiles above the strip.
    const before: Item[] = [T, [H, { from: "top", n: 1 }], "cards", D, P];
    expect(accepted(datesAllDay(), before)).toEqual(BOTH);
    expect(composed(datesAllDay(), before)).toEqual([S, `${H}*`, T, "cards", D, P]);
  });

  it("6. a rule has sent the strip up, next up comes back: under the strip, above the tiles", () => {
    const before: Item[] = [T, S, "cards", D, P];
    expect(accepted(datesAllDay(), before)).toEqual(["the strip sent up"]);
    expect(composed(datesAllDay(), before)).toEqual([T, H, S, "cards", D, P]);
  });

  it("7. the usual order: each section comes back to its default place, whatever the rules are doing today", () => {
    for (const signals of [quiet(), datesAllDay(), datesAllDay(0)]) {
      for (const key of FIVE) expect(composed(signals, USUAL.filter((k) => k !== key)), key).toEqual(USUAL);
    }
  });

  it("8. a rule's move is waiting (the strip still under the tiles), next up comes back: above the tiles, and the rules plan then lands", async () => {
    const signals = datesAllDay();
    const before: Item[] = [S, T, "cards", D, P];
    expect(accepted(signals, before)).toEqual(BOTH);
    expect(composed(signals, before)).toEqual(USUAL);
    // The board he is told, as the stored one: the next new situation is served the rules plan, the strip on top.
    const { plan } = board(signals, before);
    const told = composePlan(plan, { signals, stored: plan, pinned: [], preferences: [] });
    const next = await planWithFallback(signals, { previousPlan: told, preferences: [], pinnedSections: [], llmEnabled: false });
    expect(next.source).toBe("rules");
    expect(next.plan.sections.filter((s) => s.component !== "project_card").map(sectionKey)).toEqual(STRIP_UP);
    // Under the strip (where the rule before this one put it), the rules plan is refused and the board held.
    expect(await served(signals, [S, T, H, "cards", D, P])).toBe("previous");
  });

  it("9. the tiles sunk by a planner, Needs a date comes back: between the strip and People, not under the tiles", () => {
    const before: Item[] = [H, T, "cards", P, S];
    expect(accepted(quiet(), before)).toEqual([]);
    expect(composed(quiet(), before)).toEqual([H, T, "cards", D, P, S]);
  });

  // --- the strip sent up by a rule and still there: "the strip sent up" is the order accepted ---
  it("10. a rule sent the strip up, the talk stopped, the strip is held there; the tiles come back: under next up, not on top of the board", async () => {
    for (const strip of [OPENED, T] as Item[]) {
      const before: Item[] = [strip, H, "cards", D, P];
      expect(accepted(quiet(), before)).toEqual(["the strip sent up"]);
      expect(await served(quiet(), before)).toBe("previous"); // the usual order would move the strip down, and gives no reason
      expect(composed(quiet(), before)).toEqual([T, H, S, "cards", D, P]);
    }
  });

  it("11. on that board next up comes back: under the strip, above the tiles", () => {
    expect(composed(quiet(), [OPENED, S, "cards", D, P])).toEqual([T, H, S, "cards", D, P]);
  });

  it("12. a banner new today, the strip's move waiting behind it, next up comes back: next up, the tiles, the strip", async () => {
    const today = datesAllDay();
    today.context.sections_new_today = ["focus_banner"];
    const banner: PlanSection = { component: "focus_banner", props: { text: "Two things are late", tone: "serious" } };
    const before: Item[] = [banner, S, T, "cards", D, P];
    expect(await served(today, before)).toBe("previous"); // held today: the rules plan has no banner, and what the system put there today stays today
    expect(accepted(today, before)).toEqual(BOTH); // a day on both orders are accepted: what is new today does not say where a section goes
    expect(composed(today, before)).toEqual(["focus_banner", ...USUAL]);
    expect(composed(datesAllDay(), before)).toEqual(["focus_banner", ...USUAL]);
  });

  it("13. the very day a rule moved the strip (it may not move again today, so today's order is the usual one), next up comes back: under the strip, and the next day the plan is served", async () => {
    // The first of the Reviewer's stepped families. The list is the strip, the tiles, Needs a date, People: the
    // usual order is refused against it, the strip sent up is accepted, so next up goes by that: under the strip.
    const today = datesAllDay(0);
    const before: Item[] = [OPENED, S, "cards", D, P];
    expect(await served(today, before)).toBe("previous"); // refused today: the layout has already changed
    expect(accepted(today, before)).toEqual(["the strip sent up"]);
    expect(composed(today, before)).toEqual([T, H, S, "cards", D, P]);
    expect(await served(datesAllDay(), before)).toBe("rules"); // the next day, with his hide and show
    // Above the strip, where 472c2a7 put it that day: no order accepted, and held from the next day on.
    expect(accepted(today, [H, OPENED, S, "cards", D, P])).toEqual(["the strip sent up"]);
    expect(accepted(today, [S, OPENED, H, "cards", D, P])).toEqual([]);
  });

  it("14. a planner raised Needs a date above next up, the strip and People are hidden, the tiles come back: under next up, not above Needs a date", () => {
    const raised: PlanSection = { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" };
    const off = hidden(T, P);
    const before: Item[] = [raised, H, "cards"];
    expect(accepted(quiet(), before, off)).toEqual([]);
    expect(composed(quiet(), before, off)).toEqual([D, H, S, "cards"]);
  });

  // --- a section the rules are about to move, or have moved: his "show" does not perform the system's move ---
  it("15. a rule's move is waiting; Needs a date comes back, and People with Needs a date off: each under the strip, where it stood; and whichever way the rule goes, the plan is served", async () => {
    const waiting = datesAllDay();
    for (const before of [
      [H, S, T, "cards", P],
      [H, S, T, "cards", D],
    ] as Item[][]) {
      expect(accepted(waiting, before)).toEqual(BOTH);
      expect(composed(waiting, before)).toEqual(USUAL);
      expect(await served(waiting, before)).toBe("rules"); // (a) the move lands
      expect(await served(quiet(), before)).toBe("rules"); // (b) the talk stops with no change in his data
    }
    // Directly under the tiles (the last section in step with the strip-up order), above the waiting strip: served
    // while the rule fires, and HELD once the talk stops. His hide and show would have left that behind.
    const wrong: Item[] = [H, S, D, T, "cards", P];
    expect(await served(waiting, wrong)).toBe("rules");
    expect(await served(quiet(), wrong)).toBe("previous");
  });

  it("16. a rule's move is waiting and it is the strip itself that he hides and shows: back between the tiles and Needs a date, both orders accepted before and after, and the move lands by itself", async () => {
    const waiting = datesAllDay();
    const before: Item[] = [H, S, "cards", D, P];
    expect(accepted(waiting, before)).toEqual(BOTH);
    expect(composed(waiting, before)).toEqual(USUAL);
    expect(accepted(waiting, USUAL)).toEqual(BOTH);
    const { plan } = board(waiting, USUAL);
    const next = await planWithFallback(waiting, { previousPlan: plan, preferences: [], pinnedSections: [], llmEnabled: false });
    expect(next.source).toBe("rules");
    expect(next.plan.sections.filter((s) => s.component !== "project_card")[0]).toMatchObject({ component: "timeline", why: OPENED.why });
    // On top, where today's plan has it, the usual order would be refused from then on.
    expect(accepted(waiting, [T, H, S, "cards", D, P])).toEqual(["the strip sent up"]);
  });

  it("17. the strip held up after the talk stopped, and it is the strip he hides and shows: its usual place. The stuck move is undone, and that is intended", async () => {
    const before: Item[] = [H, S, "cards", D, P];
    expect(composed(quiet(), before)).toEqual(USUAL);
    expect(await served(quiet(), before)).toBe("rules");
  });

  it("18. named: the strip sent up, only one of next up and the tiles on the board, he hides it and shows it: the list left shows no move, and it comes back ABOVE the strip", async () => {
    // Whatever the rules are doing: the strip held up after the talk stopped, a move waiting, or the strip landed
    // and he still talking. The usual order is accepted against strip, Needs a date, People, and stays accepted. A
    // board he did not have before; it mends itself, since both orders stay accepted and the rule sends the strip
    // up again at the first change in his data after a day.
    for (const signals of [quiet(), datesAllDay(), datesAllDay(0)]) {
      const before: Item[] = [OPENED, "cards", D, P];
      expect(accepted(signals, before, hidden(H))).toEqual(BOTH);
      expect(composed(signals, before, hidden(H))).toEqual([S, T, "cards", D, P]);
      expect(accepted(signals, [S, OPENED, "cards", D, P], hidden(H))).toEqual(BOTH);
    }
    // Under the strip, where it stood, the usual order would be refused: a hold left behind once the talk stops.
    expect(accepted(quiet(), [OPENED, S, "cards", D, P], hidden(H))).toEqual(["the strip sent up"]);
  });

  it("20. what he placed, hid or banned is not the system's when an order is judged: a planner's plan that leaves People out, with Needs a date his, or hidden, standing above the tiles in it", () => {
    // He talks dates, so today's order is the strip sent up. The planner's plan is the usual order with Needs a date
    // raised above the tiles, and no People. Needs a date is HIS (he placed it under next up), or he has hidden it:
    // either way the system's sections in the plan are next up, the tiles, the strip, the usual order, accepted,
    // and People takes its usual place, under the strip. Judged as the system's, Needs a date would leave no order
    // accepted, and by today's order People would go under the tiles, above the strip.
    const signals = datesAllDay();
    const cards = defaultPlan(signals).sections.filter((s) => s.component === "project_card");
    const planners: LayoutPlan = { plan_id: "llm-x", reason_summary: null, sections: [section(H), section(D), section(S), section(T), ...cards] };
    const { plan: stored } = board(signals, [H, [D, { from: "top", n: 1 }], S, T, "cards", P]);
    expect(short(composePlan(planners, { signals, stored, pinned: [D], preferences: [] }))).toEqual([H, `${D}*`, S, T, "cards", P]);
    const { plan: without } = board(signals, [H, S, T, "cards", P]);
    expect(short(composePlan(planners, { signals, stored: without, pinned: [], preferences: hidden(D) }))).toEqual([H, S, T, "cards", P]);
    const banned: LayoutPreference[] = [{ kind: "ban_component", value: { component: D } }];
    expect(short(composePlan(planners, { signals, stored: without, pinned: [], preferences: banned }))).toEqual([H, S, T, "cards", P]);
  });

  it("21. what he has placed in this very request (no place written on it yet) is not the system's either: People sent to the top, Needs a date shown, while a rule's move waits", () => {
    // The list a request hands over: People on top, his, as plain a section as the rest. Without it the system's
    // sections are next up, the tiles, the strip: the usual order, accepted; Needs a date takes its usual place,
    // under the strip. Judged with People as the system's, no order would be accepted, and by today's order (the
    // strip first) Needs a date would go under the tiles. (Through the request the guard would put that right; the
    // rule should not need it.)
    const told = withSystems([section(P), section(H), section(S), section(T)], [section(D)], new Set([P]), datesAllDay());
    expect(told.map(sectionKey)).toEqual([P, H, S, T, D]);
  });

  it("22. nothing of the system's stands above the strip (next up hidden, the tiles his): the strip hidden and shown comes back in front of the cards, where it stood, and a card he placed keeps its neighbours", () => {
    // Found by the burn-in (seed 29979245). The strip's only neighbour in step is Needs a date, below the cards.
    // Put directly above it, the strip came back UNDER the cards and stayed there (the count has the strip on
    // neither side); and in calm mode, where the board is the default's and has the strip above the cards, the
    // list his places were read off and the board that was drawn disagreed, so a card he had placed moved up one.
    const cards = defaultPlan(quiet()).sections.filter((s) => s.component === "project_card");
    const placed = new Set([sectionKey(cards[1]), S]);
    const told = withSystems([cards[0], cards[1], section(D), section(P), section(S)], [section(T)], placed, quiet());
    expect(told.map(sectionKey)).toEqual([T, sectionKey(cards[0]), sectionKey(cards[1]), D, P, S]);
    // The board: the strip, the first card, his card (third from the top, as before), Needs a date, People, his tiles.
    const before: Item[] = ["cards", D, P, [S, { from: "bottom", n: 0 }]];
    for (const signals of [quiet(), datesAllDay()]) {
      expect(composed(signals, before, hidden(H))).toEqual([T, "cards", D, P, `${S}*`]);
      const calm = structuredClone(signals);
      calm.context.calm_mode = true;
      expect(composed(calm, before, hidden(H))).toEqual([T, "cards", D, P, `${S}*`]);
    }
    // Under a section of the system's that is out of step, when one stands above: a planner's raised People, then the cards, then Needs a date; the strip comes back under People, in front of the cards.
    const raised: PlanSection = { component: P, props: { limit: 3 }, why: "People first this week" };
    expect(withSystems([raised, cards[0], section(D)], [section(T)], new Set([S]), quiet()).map(sectionKey)).toEqual([P, T, sectionKey(cards[0]), D]);
  });

  it("23. the plainest board, with a card he placed among the cards: Needs a date comes back behind the cards, People under it, and his card keeps its place", () => {
    // Found by the round trip. Put directly under the strip (the last section in step above it), Needs a date stood
    // above the cards on the list his places are read off; the count put the cards right, and his card, third among
    // the cards by its count from the top, came out fourth.
    const signals = quiet();
    const cards = defaultPlan(signals).sections.filter((s) => s.component === "project_card");
    const his = sectionKey(cards[0]);
    const list = [section(H), section(S), section(T), cards[1], cards[2], cards[0], cards[3], section(P)];
    const told = withSystems(list, [section(D)], new Set([his]), signals).map(sectionKey);
    expect(told).toEqual([H, S, T, sectionKey(cards[1]), sectionKey(cards[2]), his, sectionKey(cards[3]), D, P]);
    // Both gone, both back: Needs a date behind the cards, People under it.
    const both = withSystems(list.filter((s) => s.component !== P), [section(D), section(P)], new Set([his]), signals).map(sectionKey);
    expect(both).toEqual([H, S, T, sectionKey(cards[1]), sectionKey(cards[2]), his, sectionKey(cards[3]), D, P]);
    // And as the composition draws a stored board that lacks it: his card third among the cards, as he placed it.
    const stored: LayoutPlan = { plan_id: "stored", reason_summary: null, sections: [section(H), section(S), section(T), cards[1], cards[2], { ...cards[0], place: { from: "top", n: 5 } }, cards[3], section(P)] };
    expect(composePlan(stored, { signals, stored, pinned: [his], preferences: [] }).sections.map(sectionKey)).toEqual([H, S, T, sectionKey(cards[1]), sectionKey(cards[2]), his, sectionKey(cards[3]), D, P]);
  });

  it("19. named: a planner moved one section, and the list left behind is in an order the rules can produce: the returning section goes by that order, and the planner's move is stepped over", () => {
    // A planner raised Needs a date above the strip, with a reason; he hides the strip and shows it. Without the strip
    // the list is next up, the tiles, Needs a date, People: the usual order, accepted. The strip takes its usual
    // place, above Needs a date; it stood under it.
    const raised: PlanSection = { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" };
    expect(accepted(quiet(), [H, S, raised, T, "cards", P])).toEqual(["the strip sent up"]); // read as the strip having moved
    expect(accepted(quiet(), [H, S, raised, "cards", P])).toEqual(BOTH);
    expect(composed(quiet(), [H, S, raised, "cards", P])).toEqual([H, S, T, "cards", D, P]);
  });
});
