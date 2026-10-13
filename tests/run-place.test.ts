// SPEC §2 (v1.02 r5): where the card run goes among the system's sections.
// The function is small and pure, so it is asked about every case there is:
// every order of every subset of the five sections that are not cards, and
// every place the plan could have named. The count is the test's own.
import { describe, expect, it } from "vitest";
import { runPlace } from "@/lib/layout/compose";
import type { PlanSection } from "@/lib/layout/plan";

const FIVE = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const ABOVE = ["hero_next_up", "stat_row"];
const BELOW = ["date_chase", "people_index"];
const CARD: PlanSection = { component: "project_card", props: { project_id: "a" } };
const section = (component: string): PlanSection => ({ component });

function orders(list: string[]): string[][] {
  if (!list.length) return [[]];
  return list.flatMap((first, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [first, ...rest]));
}
const subsets = Array.from({ length: 1 << FIVE.length }, (_, mask) => FIVE.filter((_, i) => mask & (1 << i)));
/** How many sections are on the wrong side of the cards when the run goes after `place` of them. */
const wrongSide = (order: string[], place: number) => order.filter((c, i) => (ABOVE.includes(c) && i >= place) || (BELOW.includes(c) && i < place)).length;
const usual = (order: string[]) => order.join() === FIVE.filter((c) => order.includes(c)).join();

/** (a) the lowest count there is; (b) the nearest such place to where the plan had it, the upper one on a tie; (c) the usual order gives the simple bound. */
function judge(order: string[], said: number, got: number) {
  const places = Array.from({ length: order.length + 1 }, (_, i) => i);
  const lowest = Math.min(...places.map((p) => wrongSide(order, p)));
  const what = `${order.join(" ") || "(nothing)"}, the plan's cards after ${said}: after ${got}`;
  expect(wrongSide(order, got), `(a) ${what}`).toBe(lowest);
  for (const p of places.filter((x) => wrongSide(order, x) === lowest)) {
    const [mine, other] = [Math.abs(got - said), Math.abs(p - said)];
    expect(mine < other || (mine === other && got <= p), `(b) ${what}; ${p} is as good and nearer or higher`).toBe(true);
  }
  if (usual(order)) {
    const under = Math.max(order.indexOf("hero_next_up"), order.indexOf("stat_row")) + 1;
    const lower = [order.indexOf("date_chase"), order.indexOf("people_index")].filter((i) => i !== -1);
    const above = lower.length ? Math.min(...lower) : order.length;
    expect(got, `(c) ${what}`).toBe(Math.max(under, Math.min(said, above)));
  }
}

describe("where the card run goes: every order of every subset, every place the plan could name", () => {
  it("the plan's first card says, and the run goes at the nearest place with the fewest sections on the wrong side (1,631 cases)", () => {
    let cases = 0;
    for (const subset of subsets) {
      for (const order of orders(subset)) {
        for (let said = 0; said <= order.length; said++) {
          const own = [...order.slice(0, said).map(section), CARD, ...order.slice(said).map(section), { ...CARD, props: { project_id: "b" } }];
          judge(order, said, runPlace(own));
          cases++;
        }
      }
    }
    expect(cases).toBe(1631);
  });

  it("a plan with no card of its own: as if its cards stood after next up, the tiles and the strip (326 cases)", () => {
    let cases = 0;
    for (const subset of subsets) {
      for (const order of orders(subset)) {
        const said = Math.max(order.indexOf("hero_next_up"), order.indexOf("stat_row"), order.indexOf("timeline")) + 1;
        judge(order, said, runPlace(order.map(section)));
        cases++;
      }
    }
    expect(cases).toBe(326);
  });

  it("the worked cases, in words", () => {
    const [H, S, T, D, P] = FIVE;
    const place = (order: string[], said: number) => runPlace([...order.slice(0, said).map(section), CARD, ...order.slice(said).map(section)]);
    // The usual order: cards first go right under the tiles, above the strip; cards last go above Needs a date.
    expect(place([H, S, T, D, P], 0)).toBe(2);
    expect(place([H, S, T, D, P], 5)).toBe(3);
    // A planner raised Needs a date above next up.
    expect(place([D, H, S, T, P], 0)).toBe(3);
    expect(place([D, H, S, T, P], 5)).toBe(4);
    // A planner sank the tiles to the bottom: the cards where they were are left alone.
    expect(place([H, T, D, P, S], 2)).toBe(2);
    expect(place([H, T, D, P, S], 0)).toBe(1);
    expect(place([H, T, D, P, S], 5)).toBe(2);
    // Next up and the tiles are both his (not among the system's sections): the plan's place stands, unless it is under Needs a date.
    expect(place([T, D, P], 0)).toBe(0);
    expect(place([T, D, P], 1)).toBe(1);
    expect(place([T, D, P], 3)).toBe(1);
  });

  it("a card he let go on top says nothing about where the run goes; the plan's own first card does", () => {
    const [H, S, T, D, P] = FIVE.map(section);
    expect(runPlace([{ ...CARD, place: { from: "top", n: 0 } }, H, S, T, { ...CARD, props: { project_id: "b" } }, D, P])).toBe(3);
  });
});
