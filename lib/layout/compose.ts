// Composition (SPEC §2, v1.02): a render is composed, not chosen.
//
// What is on screen is put together at every render from four things:
//   1. today's system plan: emphasis, whys, the banner, and the places of
//      the sections that are not cards (whatever card order it has is ignored);
//   2. the sections the user placed, put back where he put them;
//   3. the cards he did not place, in data order, flowing around those;
//   4. his hides and bans, then presence (a hidden card is back while its
//      project is urgent).
// The stored plan supplies only where his pins sit. Pure: no I/O.
import { backOnBoardWhy, cardOrder, deadlineWhy, isDeadlineWhy, isUrgent, sectionKey, type LayoutPlan, type PlanSection } from "./plan";
import type { Signals } from "./signals";
import type { LayoutPreference } from "./validator";

export type Place = number | "last";

const BANNER = "focus_banner";
const isCard = (s: PlanSection) => s.component === "project_card";
const cardKey = (projectId: string) => `project_card:${projectId}`;

/** The user's pins, wherever one is kept: on the plan's row, or as a pin_section preference. */
export function pinKeys(pinned: string[], preferences: LayoutPreference[]): Set<string> {
  return new Set([...pinned, ...preferences.filter((p) => p.kind === "pin_section").map((p) => p.value.section)]);
}

/** A section's place on a board: the n-th from the top, the banner not counted; the last one holds last. */
export function placeOn(sections: PlanSection[], key: string): Place | null {
  const board = sections.filter((s) => s.component !== BANNER);
  const i = board.findIndex((s) => sectionKey(s) === key);
  if (i === -1) return null;
  return i === board.length - 1 ? "last" : i;
}

/**
 * Where each pinned section sits, from the stored plan: the place stored with
 * it when it was pinned, or, the first time it is seen pinned (the pin
 * button records only the key), where it stands in the stored order. Once
 * read it is written back with the section, so it does not drift when cards
 * come and go.
 */
function placesIn(stored: LayoutPlan | null, pins: Set<string>): Map<string, { place: Place; section: PlanSection }> {
  const found = new Map<string, { place: Place; section: PlanSection }>();
  for (const s of stored?.sections ?? []) {
    const key = sectionKey(s);
    if (!pins.has(key) || found.has(key) || s.component === BANNER) continue;
    const place = s.place ?? placeOn(stored!.sections, key);
    if (place !== null) found.set(key, { place, section: s });
  }
  return found;
}

/** The sections he placed that the stored plan still has: the ones the composition puts back. */
export function placedKeys(stored: LayoutPlan | null, pinned: string[], preferences: LayoutPreference[]): Set<string> {
  return new Set(placesIn(stored, pinKeys(pinned, preferences)).keys());
}

/**
 * A plan's OWN sections: without the banner (it is always first) and without
 * what he placed (those are put back afterwards, each at its place). Every
 * system plan is read through this, the held one included
 * (lib/layout/plan-from-llm.ts), so one rule decides where the card run
 * goes: a card he pinned never says.
 */
export function ownSections(sections: PlanSection[], placed: Set<string>): PlanSection[] {
  return sections.filter((s) => s.component !== BANNER && !placed.has(sectionKey(s)));
}

/**
 * Where the card run goes among a plan's own sections that are not cards:
 * after how many of them. Its first own card says. A plan with no card of
 * its own has the run where the default has it, under the strip.
 */
export function runPlace(own: PlanSection[]): number {
  const first = own.findIndex(isCard);
  if (first !== -1) return first; // everything before the first card is not a card
  return Math.max(...["hero_next_up", "stat_row", "timeline"].map((c) => own.findIndex((s) => s.component === c))) + 1;
}

export type CompositionContext = {
  signals: Signals;
  /** The stored plan: where his pins sit, and the spec of a section he added. */
  stored: LayoutPlan | null;
  /** The pins kept on the stored plan's row. */
  pinned: string[];
  preferences: LayoutPreference[];
};

/** Compose what renders from today's system plan and what the user placed, hid and banned. */
export function composePlan(system: LayoutPlan, ctx: CompositionContext): LayoutPlan {
  const pins = pinKeys(ctx.pinned, ctx.preferences);
  const places = placesIn(ctx.stored, pins);
  const hidden = new Set(ctx.preferences.filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  const banned = new Set(ctx.preferences.filter((p) => p.kind === "ban_component").map((p) => p.value.component));
  const gone = (s: PlanSection) => banned.has(s.component) || hidden.has(sectionKey(s));

  // Cards: one for every active project and list unless he hid it (and a
  // hidden one too while its project is urgent), with today's emphasis.
  const emphasis = new Map(system.sections.filter(isCard).map((s) => [String(s.props?.project_id ?? ""), s]));
  const projects = ctx.signals.projects.filter((p) => !p.parent_id).toSorted(cardOrder);
  const cards = new Map<string, PlanSection>();
  for (const p of projects) {
    const key = cardKey(p.id);
    const back = hidden.has(key) && isUrgent(p);
    if (banned.has("project_card") || (hidden.has(key) && !back)) continue;
    const from = emphasis.get(p.id);
    // A why that counts days is today's count, whatever plan it came from: a
    // stored plan is served from the cache as long as days_left has not
    // moved, and that ticks at the hour the task is due, not at midnight.
    const counted = isDeadlineWhy(from?.why) ? deadlineWhy(p) : null;
    const why = back ? backOnBoardWhy(p) : (counted ?? from?.why);
    cards.set(key, {
      component: "project_card",
      props: { variant: "full", ...(from?.props ?? {}), project_id: p.id },
      ...(why ? { why } : {}),
    });
  }
  const run = [...cards].filter(([key]) => !places.has(key)).map(([, card]) => card);

  // The unpinned sequence: the system's own sections that are not cards, in
  // the system's order, with the card run where its first own card sits.
  // What he placed is put in afterwards, each at its place.
  const own = ownSections(system.sections, new Set(places.keys()));
  const at = runPlace(own);
  const others = own.filter((s) => !isCard(s));
  const shown = (list: PlanSection[]): PlanSection[] =>
    list
      .filter((s) => !gone(s))
      .map((s) => ({ component: s.component, ...(s.props ? { props: s.props } : {}), ...(s.why ? { why: s.why } : {}) }));
  const sequence: PlanSection[] = [...shown(others.slice(0, at)), ...run, ...shown(others.slice(at))];

  // The sections he placed, lowest place first; with fewer sections than its
  // place, a section is last. What he placed stays; the system's own moves
  // land around it. Two he placed at the same place keep the order the stored
  // plan has them in: the one placed later took the place, the earlier one
  // sits next to it (so the later of the two goes in last).
  const today = new Map(system.sections.filter((s) => !isCard(s)).map((s) => [sectionKey(s), s]));
  const inStoredOrder = [...places].map((entry, at) => ({ entry, at }));
  const numbered = inStoredOrder
    .filter(({ entry }) => entry[1].place !== "last")
    .sort((a, b) => (a.entry[1].place as number) - (b.entry[1].place as number) || b.at - a.at)
    .map(({ entry }) => entry);
  const last = [...places].filter(([, v]) => v.place === "last");
  for (const [key, { place, section }] of [...numbered, ...last]) {
    // A pin holds the place only: a card's emphasis is today's, a section the
    // system also has takes today's props, and one he added keeps its own.
    const content = isCard(section) ? cards.get(key) : (today.get(key) ?? section);
    if (!content || (!isCard(section) && gone(content))) continue;
    const placed: PlanSection = { component: content.component, ...(content.props ? { props: content.props } : {}), ...(content.why ? { why: content.why } : {}), place };
    sequence.splice(place === "last" ? sequence.length : Math.min(place, sequence.length), 0, placed);
  }

  const banner = system.sections.find((s) => s.component === BANNER && !gone(s));
  return {
    plan_id: system.plan_id,
    reason_summary: system.reason_summary ?? null,
    sections: [...(banner ? [{ component: banner.component, ...(banner.props ? { props: banner.props } : {}), ...(banner.why ? { why: banner.why } : {}) }] : []), ...sequence],
    ...(system.wishlist ? { wishlist: system.wishlist } : {}),
  };
}
