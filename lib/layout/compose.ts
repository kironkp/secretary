// Composition (SPEC §2, v1.02 r5): a render is composed, not chosen.
//
// What is on screen is put together at every render from:
//   1. today's system plan: emphasis, whys, the banner, and the order of the
//      sections that are not cards (whatever card order it has is ignored);
//   2. everything that belongs: a card for every active project and list,
//      every section of the default board, every section he added;
//   3. the cards he did not place, in data order, in one run;
//   4. what he placed, each at its place: a position on the board he was
//      last told, counted from the top or from the bottom;
//   5. his hides and bans, then presence (a hidden card is back while its
//      project is urgent).
// The stored board supplies, through this one door: the places written on
// what he placed, and (when it is the system plan: a cache hit, or held) its
// own order of the sections that are not cards. Composing the board that was
// just stored gives that same board. Pure: no I/O.
import {
  asPlace,
  backOnBoardWhy,
  cardOrder,
  deadlineWhy,
  defaultPlan,
  isBackOnBoardWhy,
  isDeadlineWhy,
  isUrgent,
  sectionKey,
  type LayoutPlan,
  type Place,
  type PlanSection,
} from "./plan";
import { inStep } from "./in-step";
import { ordersTheRulesCanProduce, planFromRules, RULES_CAN_MOVE } from "./plan-from-rules";
import { RETIRED_COMPONENTS } from "./registry";
import type { Signals } from "./signals";
// (The validator reads places through this file, and this file asks the validator one question: both are calls, none at load.)
import { movementReasons, type LayoutPreference } from "./validator";

const BANNER = "focus_banner";
const isCard = (s: PlanSection) => s.component === "project_card";
const cardKey = (projectId: string) => `project_card:${projectId}`;
const bare = (s: PlanSection): PlanSection => ({ component: s.component, ...(s.props ? { props: s.props } : {}), ...(s.why ? { why: s.why } : {}) });

/**
 * His pins, wherever one is kept: on the stored row, or as a `pin_section`
 * preference from before r5 that has not yet been given a place (once it
 * has, the row is marked and no longer read: a pin has one home).
 */
export function pinKeys(pinned: string[], preferences: LayoutPreference[]): Set<string> {
  return new Set([...pinned, ...preferences.filter((p) => p.kind === "pin_section" && p.value.migrated !== "1").map((p) => p.value.section)]);
}

/** The system's sections that belong above the card run: the default board's, before its first card. */
function upperSections(signals: Signals): Set<string> {
  const defaults = defaultPlan(signals).sections;
  const firstCard = defaults.findIndex(isCard);
  return new Set(defaults.slice(0, firstCard === -1 ? 3 : firstCard).map(sectionKey));
}

/**
 * The places of what he placed, read off a board he was told. A place counts
 * from the bottom when nothing upper stands below it on that board (upper: a
 * card he has not placed, or a system section that belongs above the cards),
 * otherwise from the top. So "to the bottom" stays the bottom when a project
 * is added, and places on one board are always distinct.
 */
export function readPlaces(sections: PlanSection[], placed: Set<string>, signals: Signals): Map<string, Place> {
  const board = sections.filter((s) => s.component !== BANNER);
  const above = upperSections(signals);
  const upper = (s: PlanSection) => !placed.has(sectionKey(s)) && (isCard(s) || above.has(sectionKey(s)));
  const places = new Map<string, Place>();
  board.forEach((s, i) => {
    const key = sectionKey(s);
    if (!placed.has(key) || places.has(key)) return;
    places.set(key, board.slice(i + 1).some(upper) ? { from: "top", n: i } : { from: "bottom", n: board.length - 1 - i });
  });
  return places;
}

/**
 * A stored row as a board: without the components retired since it was
 * written. Main still stored them; the page draws nothing for them. Left in,
 * one sat on the composed board and the stored row (told to the model, and
 * counted among the places), and a section he had placed near the bottom
 * was read one place higher. Every read of a stored row as a board comes
 * through here: as the system plan, and as where his places are.
 */
function drawable(plan: LayoutPlan): LayoutPlan {
  return plan.sections.some((s) => RETIRED_COMPONENTS.has(s.component)) ? { ...plan, sections: plan.sections.filter((s) => !RETIRED_COMPONENTS.has(s.component)) } : plan;
}

/**
 * Where each section he placed sits, from the stored board: the place written
 * on it. A pin with no place written (a row from before r5, or a preference
 * pin) is read ONCE from where the section stands in the stored order; the
 * composition writes it back, so it is never read from the order again.
 */
function placesIn(given: LayoutPlan | null, pins: Set<string>, signals: Signals): Map<string, { place: Place; section: PlanSection }> {
  const found = new Map<string, { place: Place; section: PlanSection }>();
  if (!given) return found;
  const stored = drawable(given);
  let fromOrder: Map<string, Place> | null = null;
  for (const s of stored.sections) {
    const key = sectionKey(s);
    if (!pins.has(key) || found.has(key) || s.component === BANNER) continue;
    const place = asPlace(s.place) ?? (fromOrder ??= readPlaces(stored.sections, pins, signals)).get(key);
    if (place) found.set(key, { place, section: s });
  }
  return found;
}

/** The sections he placed that the stored board still has: the ones the composition puts back. */
export function placedKeys(stored: LayoutPlan | null, pinned: string[], preferences: LayoutPreference[], signals: Signals): Set<string> {
  return new Set(placesIn(stored, pinKeys(pinned, preferences), signals).keys());
}

/**
 * A plan's OWN sections: without the banner (it is always first) and without
 * what he placed (those are put back afterwards, each at its place). Every
 * system plan is read through this, the held one included
 * (lib/layout/plan-from-llm.ts), so one rule decides where the card run
 * goes: a card he placed never says.
 */
export function ownSections(sections: PlanSection[], placed: Set<string>): PlanSection[] {
  return sections.filter((s) => s.component !== BANNER && !placed.has(sectionKey(s)));
}

/** The system's sections that belong above the cards, and those that belong below. The strip is neither. */
const ABOVE_THE_CARDS = ["hero_next_up", "stat_row"];
const BELOW_THE_CARDS = ["date_chase", "people_index"];

/**
 * Where the card run goes among a plan's own sections that are not cards:
 * after how many of them.
 *
 * The right way up, whatever the plan says: the cards go where the fewest of
 * the system's sections end up on the wrong side of them. For each place the
 * run could go, count the sections that belong above the cards and would be
 * under them, plus those that belong below and would be over them. The run
 * goes at a place with the lowest count; among those, the nearest to where
 * the plan had it (its first own card; one that still carries a place, let
 * go and not yet composed again, never says; a plan with no own card has it
 * after next up, the tiles and the strip); at equal distance, the upper one.
 *
 * With the usual order that is: never above next up or the tiles, never
 * below Needs a date or People. A planner on main put urgent cards above
 * next up; read as "the run starts here", such a plan put every card above
 * it. With a crossing (a planner may raise Needs a date above next up, or
 * sink the tiles to the bottom) no place counts zero, and the run stays as
 * near as it can to where the plan had it.
 *
 * "The system's" is each section on its own: one he has placed is not in
 * `own` and counts for nothing, and the composition hands over only the
 * sections that will be drawn (not one he hid or banned, nor one that still
 * carries a place and is no longer his). Total, and one home: the
 * composition and the held path both ask here.
 */
export function runPlace(own: PlanSection[]): number {
  const others = own.filter((s) => !isCard(s));
  const at = (component: string) => others.findIndex((s) => s.component === component);
  const first = own.findIndex((s) => isCard(s) && s.place === undefined);
  const said = first !== -1 ? own.slice(0, first).filter((s) => !isCard(s)).length : Math.max(at("hero_next_up"), at("stat_row"), at("timeline")) + 1;
  const wrongSide = (place: number) =>
    others.filter((s, i) => (ABOVE_THE_CARDS.includes(s.component) && i >= place) || (BELOW_THE_CARDS.includes(s.component) && i < place)).length;
  let best = 0;
  for (let place = 1; place <= others.length; place++) {
    const [now, was] = [wrongSide(place), wrongSide(best)];
    if (now < was || (now === was && Math.abs(place - said) < Math.abs(best - said))) best = place;
  }
  return best;
}

/**
 * The banner is first, whatever a request did above it: "the top" is under
 * the banner for both tools.
 */
export function bannerFirst(sections: PlanSection[]): PlanSection[] {
  const banner = sections.find((s) => s.component === BANNER);
  if (!banner || sections[0] === banner) return sections;
  return [banner, ...sections.filter((s) => s !== banner)];
}

/** Today's system order of the sections that are not cards: the rules plan's, the default's in calm mode. */
export function todaysOrder(signals: Signals): string[] {
  const plan = signals.context.calm_mode ? defaultPlan(signals) : planFromRules(signals);
  return plan.sections.filter((s) => !isCard(s) && s.component !== BANNER).map(sectionKey);
}

/**
 * Where a section of the system's goes on a list that lacks it: the index to
 * put it at, by `order`. The ONE place this is decided (SPEC §2), for a board
 * being composed that lacks a section of the default board (hidden or banned
 * when it was stored and not now; left out by a planner; let go and not
 * composed since) and for a request that brings a section back (shown, added
 * back, let go, a hide or a ban lifted).
 *
 * Where a plan in that order would KEEP it. Of the system's sections on the
 * list (not the cards, not the banner, not what he placed), those in step
 * with the order are the ones such a plan would not itself move against
 * this list: the validator's own reading (in-step.ts), so a place given here
 * is never one that plan is then refused for.
 *
 * And the run of the system's cards counts as a section of the order,
 * between the strip and Needs a date (`upper`: next up, the tiles and the
 * strip have the cards below them; Needs a date and People have them
 * above). The cards are never asked which sections are in step (asked,
 * with the strip under the cards, they put Needs a date above the strip),
 * and they are never read as moved. The section goes under everything that
 * precedes it: the sections in step before it in the order, and the cards
 * if they come before it. With nothing before it, above everything that
 * follows it: the sections in step after it, and the cards if they come
 * after it. Where "next to its section in step" and its side of the cards
 * cannot both hold, the side of the cards wins, both ways: next up, the
 * tiles and the strip never go below the first card of the run (even when
 * their section in step stands under the cards), Needs a date and People
 * never above its last. So a section that comes back stands on its own side
 * of the cards, and the count that follows (runPlace) has nothing to put
 * right: it moves no card for it.
 *
 * `held`: no order the rules can produce is accepted against the list (a
 * planner has moved something, and it stays), so the order is today's and
 * the validator's reading decides nothing. If two readings of what is out
 * of step are then equally long, a section that carries a reason on the
 * list is the one read as moved, or else one the rules can move. (A
 * planner's raised Needs a date against next up: read the other way, the
 * tiles came back above Needs a date, on top of the board.) If both
 * sections of the tie are of the kind, or neither is, the validator's
 * reading stands.
 *
 * The cards are never asked: where they go is counted afterwards (runPlace),
 * on the list with the section in it.
 */
export function systemsPlace(list: PlanSection[], key: string, placed: Set<string>, order: string[], held = false, upper = true): number {
  const own = (s: PlanSection) => s.component !== BANNER && !placed.has(sectionKey(s));
  const at = (k: string) => list.findIndex((s) => sectionKey(s) === k);
  // (The key is always in the order: what is put in is a section of the default board, and every order is one of those.)
  const here = order.indexOf(key);
  const on = list.filter((s) => own(s) && !isCard(s)).map(sectionKey).filter((k) => k !== key && order.includes(k));
  const run = (keys: string[]) => inStep(keys, order.filter((k) => keys.includes(k)));
  let kept = run(on);
  if (held) {
    // A section could be read as the one out of step when a run as long stands without it. First those that carry
    // a reason on the list, then those the rules can move: if a run as long stands without all of them, that run
    // is the one in step. If it does not (both sections of the tie are of that kind), the validator's reading stands.
    const reasoned = list.filter((s) => s.why).map(sectionKey);
    for (const likely of [reasoned, RULES_CAN_MOVE]) {
      const could = on.filter((k) => likely.includes(k) && run(on.filter((o) => o !== k)).size === kept.size);
      if (!could.length) continue;
      const still = run(on.filter((k) => !could.includes(k)));
      if (still.size === kept.size) kept = still;
      break;
    }
  }
  const cards = list.flatMap((s, i) => (own(s) && isCard(s) ? [i] : []));
  const before = order.slice(0, here).filter((k) => kept.has(k)).map((k) => at(k) + 1);
  if (!upper && cards.length) before.push(cards.at(-1)! + 1);
  if (before.length) return upper && cards.length ? Math.min(Math.max(...before), cards[0]) : Math.max(...before);
  // Nothing in step precedes it, so everything in step follows it. (And only what has the cards below it gets this
  // far with cards on the list: the rest have them among `before`.)
  const after = [...kept].map(at);
  if (cards.length) after.push(cards[0]);
  if (after.length) return Math.min(...after);
  // Nothing of the system's that the order knows, and no cards: in front of whatever else is the system's.
  const first = list.findIndex(own);
  return first !== -1 ? first : list[0]?.component === BANNER ? 1 : 0;
}

/** A plan's order of the sections that are not cards. */
const orderOf = (plan: LayoutPlan): string[] => plan.sections.filter((s) => !isCard(s) && s.component !== BANNER).map(sectionKey);

/**
 * The orders the rules can produce that are accepted against a board as it
 * stands (each as its order of the sections that are not cards), the one
 * that moves the least first. Judged a day on: the layout clock past its
 * day and nothing new today, which is every day the rules can produce the
 * order on. The validator's own verdict (movementReasons). In calm mode no
 * plan is asked for and the board is the default's.
 */
export function acceptedOrders(board: LayoutPlan | null, pinned: string[], preferences: LayoutPreference[], signals: Signals): string[][] {
  if (signals.context.calm_mode) return [orderOf(defaultPlan(signals))];
  const later = { ...signals, context: { ...signals.context, days_since_layout_change: Math.max(1, signals.context.days_since_layout_change), sections_new_today: [] } };
  const accepted = (plan: LayoutPlan) => movementReasons(plan, { signals: later, previousPlan: board, preferences, pinnedSections: pinned, defaultPlan: defaultPlan(signals) }).length === 0;
  return ordersTheRulesCanProduce(signals).filter(accepted).map(orderOf);
}

/**
 * `list` with each of `missing` put in where the system has it: its place
 * in the first order the rules can produce that is accepted against the
 * list as it stands (the usual order first, then the strip sent up), so
 * every such order is still accepted with the section in. If none is
 * accepted, by today's order, with a tie read against the likelier section
 * (systemsPlace, `held`). "The list as it stands" is the system's own
 * sections on it, before anything is put in: what he placed, hid or banned
 * is not the system's and is not judged. (Several sections may be put in,
 * one after the other; the order they are put in does not change where any
 * of them goes, which a test shows for every case.)
 *
 * So a section the rules are about to move is no guide for the others while
 * it waits, and when it is the one that comes back it comes back to its
 * usual place: his "show" does not perform the system's move. The move
 * lands by itself, with its reason, at the next new situation.
 */
export function withSystems(list: PlanSection[], missing: PlanSection[], placed: Set<string>, signals: Signals): PlanSection[] {
  if (!missing.length) return list;
  // (A banner on the list is neither here nor there: an order is judged a day on, when it may go.)
  const systems = list.filter((s) => !placed.has(sectionKey(s)));
  const accepted = acceptedOrders({ plan_id: "list", reason_summary: null, sections: systems }, [], [], signals);
  const [order, held] = accepted.length ? [accepted[0], false] : [todaysOrder(signals), true];
  const above = upperSections(signals);
  const next = [...list];
  for (const s of missing) next.splice(systemsPlace(next, sectionKey(s), placed, order, held, above.has(sectionKey(s))), 0, s);
  return next;
}

export type CompositionContext = {
  signals: Signals;
  /** The stored board: the places written on what he placed, and the spec of a section he added. */
  stored: LayoutPlan | null;
  /** The keys of what he placed, kept on the stored row. */
  pinned: string[];
  preferences: LayoutPreference[];
};

/** Compose what renders from today's system plan and what the user placed, hid and banned. */
export function composePlan(given: LayoutPlan, ctx: CompositionContext): LayoutPlan {
  const system = drawable(given);
  const places = placesIn(ctx.stored, pinKeys(ctx.pinned, ctx.preferences), ctx.signals);
  const placed = new Set(places.keys());
  const hidden = new Set(ctx.preferences.filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  const banned = new Set(ctx.preferences.filter((p) => p.kind === "ban_component").map((p) => p.value.component));
  const gone = (s: PlanSection) => banned.has(s.component) || hidden.has(sectionKey(s));

  // Cards: one for every active project and list unless he hid it (and a
  // hidden one too while its project is urgent), with today's emphasis. A
  // why the composition itself wrote on an earlier render is never read back
  // as the system's: the count under a deadline is today's, and "Back on
  // your board" is said only while it is true.
  const emphasis = new Map(system.sections.filter(isCard).map((s) => [String(s.props?.project_id ?? ""), s]));
  const cards = new Map<string, PlanSection>();
  for (const p of ctx.signals.projects.filter((x) => !x.parent_id).toSorted(cardOrder)) {
    const key = cardKey(p.id);
    const back = hidden.has(key) && isUrgent(p);
    if (banned.has("project_card") || (hidden.has(key) && !back)) continue;
    const from = emphasis.get(p.id);
    const systems = isBackOnBoardWhy(from?.why) ? undefined : isDeadlineWhy(from?.why) ? (deadlineWhy(p) ?? from?.why) : from?.why;
    const why = back ? backOnBoardWhy(p) : systems;
    cards.set(key, { component: "project_card", props: { variant: "full", ...(from?.props ?? {}), project_id: p.id }, ...(why ? { why } : {}) });
  }

  // The system's own sections that are not cards, in the system's order, with
  // the card run where its first own card sits. A section that still carries
  // a place and is no longer his is not where the system has it: it is left
  // out here and, if it belongs, put in below like any other the list lacks.
  // Where the cards go is worked out on the sections that will be DRAWN:
  // not one he hid or banned. The stored board does not have those, and it
  // has to compose to itself; counted, a hidden Needs a date kept the cards
  // on one side of a planner's sunk tiles at this render and let them
  // cross at the next.
  // Everything that belongs is drawn: a section of the default board that the
  // system's plan (or the stored board) lacks goes in among the system's
  // sections where the rules would keep it (withSystems). BEFORE
  // the place for the cards is worked out, so the count and the cut are on
  // one list and nothing of the system's is added after: put in afterwards
  // (472c2a7), a section that came back onto a crossed board could land on
  // the wrong side of the cards, and the board that was stored then composed
  // to a different one at the next open.
  const drawn = ownSections(system.sections, placed).filter((s) => isCard(s) || (!gone(s) && s.place === undefined));
  const lacks = (d: PlanSection) => !isCard(d) && d.component !== BANNER && !gone(d) && !placed.has(sectionKey(d)) && !drawn.some((s) => sectionKey(s) === sectionKey(d));
  const own = withSystems(drawn, defaultPlan(ctx.signals).sections.filter(lacks).map(bare), placed, ctx.signals);
  const at = runPlace(own);
  const others = own.filter((s) => !isCard(s)).map(bare);
  const flow: PlanSection[] = [...others.slice(0, at), ...[...cards].filter(([key]) => !placed.has(key)).map(([, card]) => card), ...others.slice(at)];

  // What he placed, each at its place. A place is a position only: a card's
  // emphasis is today's, a section the system also has takes today's props,
  // and one he added keeps its own.
  const today = new Map(system.sections.filter((s) => !isCard(s)).map((s) => [sectionKey(s), s]));
  const his: { place: Place; section: PlanSection }[] = [];
  for (const [key, { place, section }] of places) {
    const content = isCard(section) ? cards.get(key) : (today.get(key) ?? section);
    if (!content || (!isCard(section) && gone(content))) continue;
    his.push({ place, section: { ...bare(content), place } });
  }
  // Top-counted in place order, each at its place; then bottom-counted, each
  // at its place from the end. On a board too short for a place they keep
  // the order he was told: none goes in front of one already put in.
  const total = flow.length + his.length;
  const sequence = [...flow];
  let last = -1;
  for (const { place, section } of his.filter((h) => h.place.from === "top").toSorted((a, b) => a.place.n - b.place.n)) {
    const index = Math.max(Math.min(place.n, sequence.length), last + 1);
    sequence.splice(index, 0, section);
    last = index;
  }
  for (const { place, section } of his.filter((h) => h.place.from === "bottom").toSorted((a, b) => b.place.n - a.place.n)) {
    const index = Math.max(Math.min(total - 1 - place.n, sequence.length), last + 1);
    sequence.splice(index, 0, section);
    last = index;
  }

  const banner = system.sections.find((s) => s.component === BANNER && !gone(s));
  return {
    plan_id: system.plan_id,
    reason_summary: system.reason_summary ?? null,
    sections: [...(banner ? [bare(banner)] : []), ...sequence],
    ...(system.wishlist ? { wishlist: system.wishlist } : {}),
  };
}
