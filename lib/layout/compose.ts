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
import type { Signals } from "./signals";
import type { LayoutPreference } from "./validator";

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
 * Where each section he placed sits, from the stored board: the place written
 * on it. A pin with no place written (a row from before r5, or a preference
 * pin) is read ONCE from where the section stands in the stored order; the
 * composition writes it back, so it is never read from the order again.
 */
function placesIn(stored: LayoutPlan | null, pins: Set<string>, signals: Signals): Map<string, { place: Place; section: PlanSection }> {
  const found = new Map<string, { place: Place; section: PlanSection }>();
  if (!stored) return found;
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

/**
 * Where the card run goes among a plan's own sections that are not cards:
 * after how many of them. Its first own card says, unless that card still
 * carries a place (one he let go, not yet composed again). A plan with no
 * such card has the run where the default has it, under the strip.
 */
export function runPlace(own: PlanSection[]): number {
  const others = own.filter((s) => !isCard(s));
  const first = own.findIndex((s) => isCard(s) && s.place === undefined);
  if (first !== -1) return own.slice(0, first).filter((s) => !isCard(s)).length;
  return Math.max(...["hero_next_up", "stat_row", "timeline"].map((c) => others.findIndex((s) => s.component === c))) + 1;
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

/**
 * A section's default place on a board that lacks it: just under the nearest
 * section the default board has above it that is on this board. "Where the
 * system has it" for a section shown again, unpinned, or left out.
 */
export function defaultPlaceFor(sections: PlanSection[], section: PlanSection, defaults: PlanSection[]): number {
  const order = defaults.map((s) => sectionKey(s));
  const here = order.indexOf(sectionKey(section));
  if (here === -1) return sections.length;
  for (let i = here - 1; i >= 0; i--) {
    const at = sections.findIndex((s) => sectionKey(s) === order[i]);
    if (at !== -1) return at + 1;
  }
  return sections[0]?.component === BANNER ? 1 : 0;
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
export function composePlan(system: LayoutPlan, ctx: CompositionContext): LayoutPlan {
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
  // out here and, if it belongs, drawn at its default place below.
  const own = ownSections(system.sections, placed);
  const at = runPlace(own);
  const others = own.filter((s) => !isCard(s));
  const shown = (list: PlanSection[]) => list.filter((s) => !gone(s) && s.place === undefined).map(bare);
  const flow: PlanSection[] = [...shown(others.slice(0, at)), ...[...cards].filter(([key]) => !placed.has(key)).map(([, card]) => card), ...shown(others.slice(at))];

  // Everything that belongs is drawn: a section of the default board that the
  // system's plan (or the stored board) lacks goes in at its default place.
  const defaults = defaultPlan(ctx.signals).sections;
  for (const d of defaults) {
    const key = sectionKey(d);
    if (isCard(d) || d.component === BANNER || gone(d) || placed.has(key) || flow.some((s) => sectionKey(s) === key)) continue;
    flow.splice(defaultPlaceFor(flow, d, defaults), 0, bare(d));
  }

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
