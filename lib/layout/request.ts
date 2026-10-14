// Every request of his about the board goes through this one function (SPEC
// §2, v1.02 r5): both tools, the pin button, unpin, Put it back, the Settings
// page lifting a hide or a ban or removing a pin, the preference tool's pin
// and its ban.
//
// One computation, in this order: start from what an open shows NOW; change
// the state in memory; run on that state exactly what an open runs; check
// that the board bears out what is about to be said; only then write, and
// answer with that board. If the check fails nothing is written, and the
// reply says why in the section's name, never its key.
//
// After every request the place of EVERY section he has placed is read again
// from the board he was just told, so places are positions on one real board
// and are always distinct.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects } from "@/lib/db/schema";
import { acceptedOrders, bannerFirst, readPlaces, withSystems } from "./compose";
import { nameOfKey, type NamedProject } from "./names";
import { planWithFallback } from "./plan-from-llm";
import { defaultPlan, isUrgent, sectionKey, urgencyLabel, type LayoutPlan, type PlanSection } from "./plan";
import { asStored, hashOnceStored, loadState, markPinPreferences, openOn, placedOn, planContent, type BoardState } from "./plan-store";
import { REGISTRY_COMPONENTS, REGISTRY_VERSION } from "./registry";
import { signalsHash } from "./signals";
import type { LayoutPreference } from "./validator";

const BANNER = "focus_banner";
const CARD = "project_card";
const isCardKey = (key: string) => key.startsWith(`${CARD}:`);
const isCard = (s: PlanSection) => s.component === CARD;

export type BoardOp =
  /** Up and down swap with the neighbour; the top is under the banner; the bottom is the end; an index is a position on the plan as it is numbered. */
  | { op: "move"; key: string; to: "top" | "bottom" | "up" | "down" | { index: number } }
  | { op: "hide"; key: string }
  | { op: "show"; key: string }
  | { op: "add"; section: PlanSection; at?: number }
  | { op: "pin"; key: string }
  | { op: "unpin"; key: string }
  | { op: "set_props"; key: string; props: Record<string, unknown> };

export type BoardRequest = {
  ops?: BoardOp[];
  /** Put it back: the earlier row's board and what was placed on it, with today's hides. */
  revert?: boolean;
  /** A stored preference to remove (Settings, or the preference tool): a hide or a ban lifted, or any other. */
  liftPreference?: string;
  /** A component he never wants to see. */
  ban?: string;
};

export type BoardReply =
  | { ok: true; version: number; plan: LayoutPlan; shown: string[]; hidden: string[]; sized: boolean }
  | { ok: false; error: string };

/** A section as it goes onto the board when it is brought there: the bare component, or a project's card. */
const sectionFor = (key: string): PlanSection =>
  isCardKey(key) ? { component: CARD, props: { project_id: key.slice(CARD.length + 1), variant: "full" } } : { component: key };
const samePreference = (a: LayoutPreference, b: { kind: string; value: unknown }) => a.kind === b.kind && JSON.stringify(a.value) === JSON.stringify(b.value);

export async function requestBoard(userId: string, request: BoardRequest): Promise<BoardReply> {
  const [state, projectRows, lifted] = await Promise.all([
    loadState(userId),
    db.select({ id: projects.id, name: projects.name, kind: projects.kind }).from(projects).where(eq(projects.userId, userId)),
    request.liftPreference
      ? db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.id, request.liftPreference))).then((rows) => rows[0] ?? null)
      : null,
  ]);
  const names = new Map<string, NamedProject>(projectRows.map((p) => [p.id, p]));
  const say = (key: string) => nameOfKey(key, names);
  const refuse = (error: string): BoardReply => ({ ok: false, error });
  const { signals } = state;
  const defaults = new Set(defaultPlan(signals).sections.map((s) => sectionKey(s)));
  const active = new Map(signals.projects.filter((p) => !p.parent_id).map((p) => [`${CARD}:${p.id}`, p]));
  const known = (component: string) => REGISTRY_COMPONENTS.includes(component as never) || state.dynamic.some((d) => d.name === component);
  /** Not a card and not one of the default board's: on the board only because someone put it there. Once his, it is always placed. */
  const isExtra = (key: string) => !isCardKey(key) && !defaults.has(key) && key !== BANNER;

  // --- the state as it would be written, in memory ------------------------------
  const ops = [...(request.ops ?? [])];
  let preferences = state.preferences;
  const liftedValue = (lifted?.value ?? {}) as Record<string, string>;
  if (lifted) {
    const at = preferences.findIndex((p) => samePreference(p, lifted));
    preferences = preferences.filter((_, i) => i !== at);
  }
  const banned = new Set(preferences.filter((p) => p.kind === "ban_component").map((p) => p.value.component));
  const hides = new Set(state.preferences.filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  /** A ban that now also remembers a section he had put on the board (its hide is lifted while the ban stands). */
  let remembers: string | null = null;
  if (lifted?.kind === "hide_section") {
    const section = liftedValue.section;
    const component = isCardKey(section) ? CARD : section;
    // A hide lifted is a show like any other. When there is nothing to show
    // (the project has been archived or deleted since, the component retired)
    // or a ban stands, the hide simply goes: it must not stay in Settings for
    // good because the board cannot draw what it was hiding.
    const drawable = isCardKey(section) ? active.has(section) : known(component);
    if (drawable && !banned.has(component)) ops.unshift({ op: "show", key: section });
    else {
      hides.delete(section);
      if (banned.has(component) && !isCardKey(section)) remembers = component;
    }
  }
  const hiddenBefore = new Set(hides);
  const claims = { present: new Set<string>(), absent: new Set<string>() };
  /** What this request sends back to where the system has it: shown again, added back, let go. */
  const floating = new Set<string>();
  let sized = false;

  let sections: PlanSection[];
  let reason: string | null;
  let placed: Set<string>;
  let reverted: { id: string } | null = null;
  if (request.revert) {
    const rows = await db.select().from(layoutSpecs).where(and(eq(layoutSpecs.userId, userId), eq(layoutSpecs.kind, "plan"))).orderBy(desc(layoutSpecs.version)).limit(2);
    if (rows.length < 2) return refuse("Nothing to revert to");
    reverted = { id: rows[0].id };
    const earlier = rows[1].spec as LayoutPlan;
    // Not behind the first board stored under this version: a row from before it is not a board to return to.
    if (!earlier.composed) return refuse("The board before this one is from before the last update, so it cannot be put back. Nothing was changed.");
    sections = structuredClone(earlier.sections);
    reason = earlier.reason_summary ?? null;
    placed = new Set(placedOn(earlier)); // a row of this version: what he placed carries its place
  } else {
    // What an open shows now: the composition writes its place on everything he placed.
    const now = (await openOn(state)).plan;
    sections = structuredClone(now.sections);
    reason = now.reason_summary ?? null;
    placed = new Set(placedOn(now));
  }
  const has = (key: string) => sections.some((s) => sectionKey(s) === key);
  const take = (key: string) => sections.splice(sections.findIndex((s) => sectionKey(s) === key), 1)[0];
  const bring = (key: string) => {
    hides.delete(key);
    claims.present.add(key);
    claims.absent.delete(key);
    floating.delete(key);
  };

  // A ban: a section he placed goes with it, and so does its place. The ban
  // remembers a section that was only on the board because he put it there,
  // so lifting it brings that section back (placed, at the end).
  let ban: LayoutPreference | null = null;
  if (request.ban && !banned.has(request.ban)) {
    const his = sections.some((s) => s.component === request.ban && isExtra(sectionKey(s)) && placed.has(sectionKey(s)));
    ban = { kind: "ban_component", value: { component: request.ban, ...(his ? { added: "1" } : {}) } };
    banned.add(request.ban);
  }
  if (lifted?.kind === "ban_component" && liftedValue.added === "1" && !hides.has(liftedValue.component) && known(liftedValue.component)) {
    ops.unshift({ op: "show", key: liftedValue.component });
  }

  for (const op of ops) {
    const key = op.op === "add" ? sectionKey(op.section) : op.key;
    const component = isCardKey(key) ? CARD : key;
    if (op.op !== "hide" && banned.has(component)) return refuse(`You asked never to be shown ${say(key)}. Take that back first, here or in Settings. Nothing was changed.`);
    if (op.op !== "hide" && isCardKey(key) && !active.has(key)) return refuse(`${say(key)} has no card on the dashboard: only your active projects and lists do. Nothing was changed.`);
    if (key === BANNER && (op.op === "move" || op.op === "pin" || op.op === "unpin" || op.op === "add")) return refuse("The banner is always first when there is one. You can hide it. Nothing was changed.");

    if (op.op === "add") {
      if (has(key)) return refuse(`${say(key)} is already on the dashboard. Move it instead.`);
      if (!isCardKey(key) && !known(component)) return refuse(`There is no "${component}" to put on the dashboard. Nothing was changed.`);
      bring(key);
      // Something of the usual board that he had hidden is a show: it goes where the system has it.
      if (!isExtra(key)) {
        floating.add(key);
        continue;
      }
      sections.splice(Math.min(op.at ?? sections.length, sections.length), 0, { component, ...(op.section.props ? { props: op.section.props } : {}) });
      sections = bannerFirst(sections);
      placed.add(key);
    } else if (op.op === "show") {
      bring(key);
      // Only on the board because he put it there: it comes back placed, at the end. Anything else goes where the system has it.
      if (!has(key) && isExtra(key) && known(component)) {
        sections.push(sectionFor(key));
        placed.add(key);
      } else if (!has(key)) floating.add(key);
    } else if (op.op === "hide") {
      // (Shown earlier in this same request, it is on its way back to the board: the last word wins.)
      if (!has(key) && !floating.has(key)) return refuse(`There's no ${say(key)} on the dashboard to hide.`);
      // (An urgent project's card cannot be hidden: the open draws it all the same, and the claim below is what refuses.)
      if (has(key)) take(key);
      placed.delete(key);
      floating.delete(key);
      hides.add(key);
      claims.absent.add(key);
      claims.present.delete(key);
    } else if (op.op === "unpin") {
      if (!has(key)) return refuse(`There's no ${say(key)} on the dashboard.`);
      if (isExtra(key)) return refuse(`${say(key)} stays where you put it: it is not part of the usual dashboard, so there is nowhere else for it to go. Hide it if you do not want it there.`);
      // Where the system has it (worked out below, with everything else it sends there).
      placed.delete(key);
      floating.add(key);
      claims.present.add(key);
    } else if (op.op === "pin") {
      if (!has(key)) return refuse(`There's no ${say(key)} on the dashboard to pin.`);
      placed.add(key);
      claims.present.add(key);
    } else if (op.op === "set_props") {
      const at = sections.findIndex((s) => sectionKey(s) === key);
      if (at === -1) return refuse(`There's no ${say(key)} on the dashboard.`);
      sections[at] = { ...sections[at], props: { ...sections[at].props, ...op.props } };
      sized = true;
    } else {
      // A move. By name ("put the list at the top"), something not on the
      // board is brought onto it first; by index it has to be there.
      if (!has(key)) {
        if (typeof op.to === "object" || (!hides.has(key) && !active.has(key) && !defaults.has(key))) return refuse(`There's no ${say(key)} on the dashboard.`);
        sections.push(sectionFor(key));
      }
      bring(key);
      const from = sections.findIndex((s) => sectionKey(s) === key);
      if (op.to === "up" || op.to === "down") {
        // One step is a swap with the neighbour, whatever it is.
        const other = op.to === "up" ? from - 1 : from + 1;
        // (Swapped with the banner, it is put back under it just below: the banner is first whatever a request did.)
        if (other >= 0 && other < sections.length) [sections[from], sections[other]] = [sections[other], sections[from]];
        sections = bannerFirst(sections);
      } else {
        const moved = take(key);
        sections.splice(op.to === "top" ? 0 : op.to === "bottom" ? sections.length : Math.min(op.to.index, sections.length), 0, moved);
        sections = bannerFirst(sections);
      }
      placed.add(key);
    }
  }

  // --- what an open runs, on that state -------------------------------------------
  /** The board with the place of everything he placed read off it, and no place on anything else. */
  const written = (list: PlanSection[], keys: Set<string>): PlanSection[] => {
    const places = readPlaces(list, keys, signals);
    return list.map((s) => {
      const place = places.get(sectionKey(s));
      return { component: s.component, ...(s.props ? { props: s.props } : {}), ...(s.why ? { why: s.why } : {}), ...(place ? { place } : {}) };
    });
  };
  preferences = [
    ...preferences.filter((p) => p.kind !== "hide_section" || hides.has(p.value.section)),
    ...[...hides].filter((key) => !hiddenBefore.has(key)).map((key): LayoutPreference => ({ kind: "hide_section", value: { section: key } })),
    ...(ban ? [ban] : []),
  ];
  const plan_id = `user-${Date.now().toString(36)}`;
  /**
   * What an open shows once `list` is the stored board, with what he placed
   * on it at the places read off it; or, for Put it back, at the places the
   * earlier row wrote (its board is not one he is looking at now).
   */
  // The state as it will be once written: `draft` is the stored board, for
  // exactly these signals, with these pins and preferences. (Served again
  // for the same signals, a stored board is composed without the layout
  // clock being read; the row is stored under the hash the next open works
  // out, clock and all, where it is written below.)
  const stateWith = (draft: LayoutPlan, pinned: string[]): BoardState => {
    const after = { ...signals, context: { ...signals.context, pinned_sections: pinned } };
    return {
      ...state,
      signals: after,
      preferences,
      head: { spec: draft, pinned, signalsHash: signalsHash(after, REGISTRY_VERSION), version: (state.head?.version ?? 0) + 1, createdAt: new Date() },
    };
  };
  const openWith = async (list: PlanSection[], places: "read" | "kept" = "read") => {
    const on = new Set(list.map((s) => sectionKey(s)));
    const pinned = [...placed].filter((key) => on.has(key) && key !== BANNER);
    const draft: LayoutPlan = { plan_id, reason_summary: reason, sections: places === "read" ? written(list, new Set(pinned)) : list };
    return (await openOn(stateWith(draft, pinned))).plan;
  };
  /** The cards this request lets go (unpinned): back with the system's cards, by the data. */
  let letGo: PlanSection[] = [];
  /**
   * The board for a list he is told. The composition and its count settle
   * the system's sections and the cards FIRST (in calm mode, the default
   * board's order). Then everything he placed is stood next to the neighbour
   * it had on the list, and his places are read off THAT board: it is the
   * list and the board. A place is a number, and until this the number was
   * read off the list: where the count then moved the cards, or the list had
   * a section on the other side of them, the number pointed at another
   * neighbour.
   *
   * Each thing of his has ONE neighbour, by the test its place already uses
   * (readPlaces). Counted from the top (a card of the run, or next up, the
   * tiles or the strip, stands somewhere below it): the nearest thing ABOVE
   * it that is not his; with none, the top. Counted from the bottom: the
   * nearest thing BELOW it that is not his; with none, the bottom. Two of
   * his side by side look past each other, and several with one neighbour
   * keep the order they had.
   *
   * A card that comes back (shown, let go) is not on the list: the
   * composition draws it in the run by the data, and it is nobody's
   * neighbour. A card let go is in the draft the composition is asked with,
   * for its emphasis only: last, where it does not say where the run goes
   * (the first card of a plan says that; and a lone card that stands last
   * says what no card at all would, which a test shows for every order).
   */
  const settle = async (list: PlanSection[]): Promise<LayoutPlan> => {
    const his = (s: PlanSection) => placed.has(sectionKey(s));
    const first = await openWith([...list, ...letGo]);
    const places = readPlaces(list, new Set(list.filter(his).map((s) => sectionKey(s))), signals);
    const fromTop = (s: PlanSection) => places.get(sectionKey(s))?.from === "top";
    const out = first.sections.filter((s) => s.place === undefined);
    const at = (key: string) => out.findIndex((x) => sectionKey(x) === key);
    // From the top: under the nearest thing above that is not his (or under the one of his just put there).
    let above: string | null = null;
    for (const s of list) {
      if (his(s) && !fromTop(s)) continue;
      if (his(s)) out.splice(above === null ? 0 : at(above) + 1, 0, s);
      above = sectionKey(s);
    }
    // From the bottom: above the nearest thing below that is not his (or above the one of his just put there).
    let below: string | null = null;
    for (const s of list.toReversed()) {
      if (his(s) && fromTop(s)) continue;
      if (his(s)) out.splice(below === null ? out.length : at(below), 0, s);
      below = sectionKey(s);
    }
    return openWith(out);
  };
  /** The system's own on a list he is told: not the banner, not what he placed. */
  const own = (t: PlanSection) => t.component !== BANNER && !placed.has(sectionKey(t));
  // Put it back: the earlier row's board with what was placed on it, each at
  // the place that row wrote, on today's data and under today's hides.
  let board: LayoutPlan;
  /** The list he is told, and the sections of the system's this request brings back onto it. */
  let told: PlanSection[] = [];
  let returning: PlanSection[] = [];
  if (request.revert) board = await openWith(bannerFirst(sections), "kept");
  else {
    // What this request sends back to the system (shown again, added back,
    // let go) goes where the system has it, and where that is, is the
    // composition's to say, not this function's. It is asked with those
    // sections off the board, for what will be drawn. Everything else keeps
    // the order he saw.
    const standing = bannerFirst(sections).filter((s) => !floating.has(sectionKey(s)));
    letGo = sections.filter((s) => floating.has(sectionKey(s)) && isCard(s));
    const systems = await openWith(standing);
    const drawnBy = new Set(systems.sections.map((s) => sectionKey(s)));
    told = standing.filter((s) => drawnBy.has(sectionKey(s)));
    const onIt = (s: PlanSection) => told.some((t) => sectionKey(t) === sectionKey(s));
    // A section that comes back is put onto the list he saw by the
    // composition's own function (systemsPlace: where the rules would keep
    // it), so what he placed can have it for a neighbour. A card that comes
    // back is not: the composition draws it in the run by the data.
    returning = systems.sections.filter((s) => s.place === undefined && s.component !== BANNER && !isCard(s) && !onIt(s));
    told = withSystems(told, returning, placed, signals);
    board = await settle(told);
  }
  // --- the guard: his request does not hold the system's plan -----------------------------
  // Every place is read again from the board he is told. What left the board
  // (its project archived, its component banned) has no place any more.
  const storedAs = (b: LayoutPlan): LayoutPlan => ({ ...b, plan_id, sections: written(b.sections, new Set(placedOn(b))) });
  /** What a NEW open would be served on a state, one not served from the stored row: the rules chain, in memory. No model call. */
  const served = async (on: BoardState) =>
    on.signals.context.calm_mode
      ? "calm"
      : (await planWithFallback(on.signals, { previousPlan: on.head?.spec ?? null, preferences: on.preferences, pinnedSections: on.head?.pinned ?? [], llmEnabled: false, dynamicComponents: on.dynamic })).source;
  // Before it writes, the request asks two things of the board he is about
  // to be told, against the board as it is. What a new open would be served
  // today: the rules plan now, and held after, is a hold. And each order the
  // rules can produce, the clock a day on: accepted now and refused after is
  // a hold left behind for a later day (the talk stops, a rule starts). If
  // his request would leave either, a section it brought back stands at the
  // wrong place: the other places among the system's sections are tried,
  // nearest first and the upper one at equal distance, and the first that
  // leaves no hold is taken. If none does, his request is applied at the
  // rule's place all the same (it is never refused for this) and the server
  // log says so. Not for Put it back, which puts the system's own order
  // back. (In calm mode no plan is asked for, and both questions say so.)
  // The rule is built so that none of this happens with the rules as they
  // are (withSystems); this is the check that says so.
  let leftHeld: string | null = null;
  if (!request.revert) {
    const servedNow = await served(state);
    const orders = (spec: LayoutPlan | null, pinned: string[], prefs: LayoutPreference[]) => acceptedOrders(spec, pinned, prefs, signals).map((order) => order.join());
    const ordersNow = orders(state.head?.spec ?? null, state.head?.pinned ?? [], state.preferences);
    const held = async (b: LayoutPlan) => {
      const [spec, pinned] = [storedAs(b), placedOn(storedAs(b))];
      const after = orders(spec, pinned, preferences);
      if (ordersNow.some((order) => !after.includes(order))) return true;
      return servedNow === "rules" && (await served(stateWith(spec, pinned))) !== "rules";
    };
    if (await held(board)) {
      let tried = 0;
      let found = false;
      search: for (const s of returning) {
        const rest = told.filter((t) => t !== s);
        const systemsAt = rest.flatMap((t, i) => (own(t) && !isCard(t) ? [i] : []));
        const first = rest.findIndex(own);
        const spot = (k: number) => (k === 0 ? (first !== -1 ? first : rest[0]?.component === BANNER ? 1 : 0) : systemsAt[k - 1] + 1);
        const rule = systemsAt.filter((i) => i < told.indexOf(s)).length;
        const others = Array.from({ length: systemsAt.length + 1 }, (_, k) => k).filter((k) => k !== rule);
        // (Nearest first; of two as near, the upper one: the places are in order and the sort keeps it.)
        for (const k of others.toSorted((a, b) => Math.abs(a - rule) - Math.abs(b - rule))) {
          tried++;
          const list = [...rest.slice(0, spot(k)), s, ...rest.slice(spot(k))];
          const other = await settle(list);
          if (await held(other)) continue;
          [told, board, found] = [list, other, true];
          break search;
        }
      }
      if (!found) leftHeld = `[layout] a request leaves the rules plan held, now or on a later day: ${ops.length} operation(s), ${returning.length} section(s) brought back, ${tried} other place(s) tried`;
    }
  }

  // --- the claims, on that board ------------------------------------------------------
  const drawn = new Set(board.sections.map((s) => sectionKey(s)));
  for (const key of claims.present) {
    if (!drawn.has(key)) return refuse(`That would not show on the dashboard: there is no place on it for ${say(key)}. Nothing was changed.`);
  }
  for (const key of claims.absent) {
    if (!drawn.has(key)) continue;
    // Still drawn after he hid it: an urgent project always has its card (invariant 4, presence).
    const project = active.get(key);
    return refuse(
      project && isUrgent(project)
        ? `That would break a dashboard rule: urgent project "${project.name}" (${urgencyLabel(project)}) would have no card. Nothing was changed.`
        : `That would not show on the dashboard: ${say(key)} would still be on it. Nothing was changed.`
    );
  }
  // A size or accent he set has to be on that board too (calm mode shows every section the default way).
  for (const op of ops) {
    if (op.op !== "set_props") continue;
    const section = board.sections.find((x) => sectionKey(x) === op.key);
    if (Object.entries(op.props).every(([name, value]) => JSON.stringify(section?.props?.[name]) === JSON.stringify(value))) continue;
    return refuse(
      signals.context.calm_mode
        ? "The dashboard is in calm mode, which shows every section the plain way. Turn calm mode off to change a size. Nothing was changed."
        : `That would not show on the dashboard: ${say(op.key)} would look as it does now. Nothing was changed.`
    );
  }

  // --- write, and answer with that board ------------------------------------------------
  if (leftHeld) console.warn(leftHeld);
  const plan = storedAs(board);
  const stillPlaced = placedOn(plan);
  if (lifted) await db.delete(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.id, lifted.id)));
  if (remembers) {
    const bans = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "ban_component")));
    for (const row of bans) {
      const value = row.value as Record<string, string>;
      if (value.component === remembers && isExtra(remembers)) await db.update(layoutPreferences).set({ value: { ...value, added: "1" } }).where(eq(layoutPreferences.id, row.id));
    }
  }
  if (ban) await db.insert(layoutPreferences).values({ userId, kind: "ban_component", value: ban.value });
  const hideRows = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "hide_section")));
  for (const row of hideRows) {
    if (!hides.has((row.value as Record<string, string>).section)) await db.delete(layoutPreferences).where(eq(layoutPreferences.id, row.id));
  }
  for (const key of hides) {
    if (!hiddenBefore.has(key)) await db.insert(layoutPreferences).values({ userId, kind: "hide_section", value: { section: key } });
  }
  // "Shown" is what came back where the system has it; what he asked to be put somewhere is placed, not merely shown.
  const reply = { ok: true as const, plan, shown: [...claims.present].filter((key) => hiddenBefore.has(key) && !stillPlaced.includes(key)), hidden: [...claims.absent], sized };
  // The stored board is already this one: nothing to write (a ban of something not on it, a pin already there).
  const head = state.head;
  // (Compared as content: what comes back from the database has its keys in the database's order.)
  if (!reverted && head && planContent(head.spec) === planContent(plan) && head.pinned.join() === stillPlaced.join()) {
    return { ...reply, version: head.version };
  }
  if (reverted) await db.update(layoutSpecs).set({ outcome: "reverted" }).where(eq(layoutSpecs.id, reverted.id));
  const version = (head?.version ?? 0) + 1;
  await db.insert(layoutSpecs).values({
    userId,
    version,
    spec: asStored(plan),
    pinned: stillPlaced,
    kind: "plan",
    // Under the hash the next open will work out for it (its own pins, the
    // clock as this row leaves it): that open serves this very board, and the
    // planner is not asked about a situation it has already answered.
    signalsHash: hashOnceStored(signals, plan, head ? { spec: head.spec, pinned: head.pinned } : null, stillPlaced),
    reasonSummary: plan.reason_summary ?? null,
    outcome: "accepted",
  });
  await markPinPreferences(userId, stillPlaced);
  return { ...reply, version };
}
