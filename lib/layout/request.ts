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
import { bannerFirst, readPlaces } from "./compose";
import { nameOfKey, type NamedProject } from "./names";
import { planFromRules } from "./plan-from-rules";
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
  const openWith = async (list: PlanSection[], places: "read" | "kept" = "read") => {
    const on = new Set(list.map((s) => sectionKey(s)));
    const pinned = [...placed].filter((key) => on.has(key) && key !== BANNER);
    const draft: LayoutPlan = { plan_id, reason_summary: reason, sections: places === "read" ? written(list, new Set(pinned)) : list };
    // The state as it will be once written: this board is the stored one,
    // for exactly these signals, with these pins and preferences. (Served
    // again for the same signals, a stored board is composed without the
    // layout clock being read; the row is stored under the hash the next
    // open works out, clock and all, where it is written below.)
    const after = { ...signals, context: { ...signals.context, pinned_sections: pinned } };
    const next: BoardState = {
      ...state,
      signals: after,
      preferences,
      head: { spec: draft, pinned, signalsHash: signalsHash(after, REGISTRY_VERSION), version: (state.head?.version ?? 0) + 1, createdAt: new Date() },
    };
    return (await openOn(next)).plan;
  };
  // Put it back: the earlier row's board with what was placed on it, each at
  // the place that row wrote, on today's data and under today's hides.
  let board: LayoutPlan;
  if (request.revert) board = await openWith(bannerFirst(sections), "kept");
  else {
    // Where the system has what this request sends back to it (a card by the
    // data, another section at its default place) is the composition's to say:
    // it is asked with those sections off the board, and they then go in under
    // the system's section each one follows there. Everything else keeps the
    // order he saw. An unpinned card stays in the draft for its emphasis only.
    const standing = bannerFirst(sections).filter((s) => !floating.has(sectionKey(s)));
    const run = standing.findIndex((s) => isCard(s) && !placed.has(sectionKey(s)));
    const asked = [...standing];
    // (Beside a card of the run, so it does not say where the run goes; with no run to stand in, it is left out.)
    if (run !== -1) asked.splice(run + 1, 0, ...sections.filter((s) => floating.has(sectionKey(s)) && isCard(s)));
    const systems = await openWith(asked);
    const flow = systems.sections.filter((s) => s.place === undefined && s.component !== BANNER);
    const drawnBy = new Set(systems.sections.map((s) => sectionKey(s)));
    const told = standing.filter((s) => drawnBy.has(sectionKey(s)));
    // The system's order today: the rules plan's (the default's in calm
    // mode). A section that comes back goes where THAT has it, so the board
    // he is told is not one the rules plan would then be refused against.
    const todays = (signals.context.calm_mode ? defaultPlan(signals) : planFromRules(signals)).sections.map((s) => sectionKey(s));
    for (const s of flow) {
      const key = sectionKey(s);
      if (told.some((t) => sectionKey(t) === key)) continue;
      const own = (t: PlanSection) => t.component !== BANNER && !placed.has(sectionKey(t));
      // Under the nearest of the system's sections above it that is on the
      // board; else on top of them. A card's neighbours are the run's, in
      // data order; another section's are today's system order.
      const order = isCard(s) || !todays.includes(key) ? flow.map((f) => sectionKey(f)) : todays;
      const above = order.slice(0, order.indexOf(key)).findLast((k) => told.some((t) => sectionKey(t) === k && own(t)));
      const firstOwn = told.findIndex(own);
      const at = above ? told.findIndex((t) => sectionKey(t) === above) + 1 : firstOwn !== -1 ? firstOwn : told[0]?.component === BANNER ? 1 : 0;
      told.splice(at, 0, s);
    }
    board = await openWith(told);
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
  // Every place is read again from the board he is told. What left the board
  // (its project archived, its component banned) has no place any more.
  const plan: LayoutPlan = { ...board, plan_id, sections: written(board.sections, new Set(placedOn(board))) };
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
