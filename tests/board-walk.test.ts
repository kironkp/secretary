// The gate for the Overview's composition (SPEC §2, v1.02 r5): a seeded random
// walk over everything that can change the board, with the same questions
// asked after every step. Three rounds were offered on examples and failed on
// a state no example had: two sections he placed meeting at one place on a
// board that had since grown shorter. Examples cannot be the gate again.
//
// Everything goes through the real paths: both tools through the tool
// executor, an open as compute-then-store, the pin button, Put it back, calm
// mode and the Settings route that lifts a preference through their route
// handler. Their limits, accepted and named here:
// - the planner's ANSWER is put in through persistPlan's `call` seam (the
//   budget is $0); everything after the answer is the real code;
// - the route handlers run with a faked session;
// - "the next day" is stored versions made two days old; the chip's own test
//   (at the end of this file) moves the clock with a faked Date, because a
//   browser's clock can be moved and the server's cannot.
//
// BOARD_WALKS, BOARD_STEPS and BOARD_SEED size the run. The suite runs a small
// one; the long one (BOARD_WALKS=120 BOARD_STEPS=30) is run before an offer.
// A failing walk prints its last six moves and the stored board, each place
// and pin marked.
process.env.TZ = "UTC";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

const session = vi.hoisted(() => {
  process.env.ADAPTIVE_V2 = "true"; // the layout route reads it when it is loaded
  return { user: null as null | { id: string; email: string; name: string; timezone: string } };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
});
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));

import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects, tasks, user } from "@/lib/db/schema";
import { dueLabel } from "@/lib/due";
import { boardSectionNames } from "@/lib/layout/arrange";
import { composePlan } from "@/lib/layout/compose";
import { defaultPlan, isUrgent, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage, planWithFallback } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import type { Signals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { POST as layoutRoute } from "@/app/api/layout/route";

const TZ = "America/Los_Angeles";
const WALKS = Number(process.env.BOARD_WALKS ?? 8);
const STEPS = Number(process.env.BOARD_STEPS ?? 16);
const SEED = Number(process.env.BOARD_SEED ?? 20261013);
const NAMES = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris"];
const NEW_NAMES = ["Juniper", "Kestrel", "Larch", "Maple", "Nettle", "Oakum", "Pippin", "Quince"];
const SAID: Record<string, string> = { hero_next_up: "next up", stat_row: "stats", timeline: "progress", date_chase: "needs a date", people_index: "people", kanban: "kanban", coming_up: "coming up", documents: "documents", suggested_zone: "suggestions" };
const DEFAULT_SECTIONS = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const ADDABLE = ["kanban", "coming_up", "documents", "suggested_zone"];
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const isCard = (key: string) => key.startsWith("project_card:");
const users: string[] = [];

/** A small seeded generator, so a failing walk can be run again. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)], chance: (p: number) => next() < p };
}

type Complaint = { check: string; detail: string };
type Told = { key: string; from: "top" | "bottom"; n: number };

async function walk(index: number) {
  const r = rng(SEED + index * 7919);
  const size = [9, 5, 3, 9][index % 4];
  const id = `test-walk-${crypto.randomUUID()}`;
  users.push(id);
  const me = { id, email: `${id}@v102.test`, name: "Walker", timezone: TZ };
  await db.insert(user).values({ id, name: me.name, email: me.email, timezone: TZ });
  const ids = new Map<string, string>(); // name -> project id
  const kinds = new Map<string, "project" | "list">(); // card key -> kind
  const addProject = async (name: string, due: number | null, kind: "project" | "list" = "project", parentId?: string) => {
    const [p] = await db.insert(projects).values({ userId: id, name, kind, status: "active", parentId }).returning();
    if (!parentId) {
      ids.set(name, p.id);
      kinds.set(`project_card:${p.id}`, kind);
    }
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
    return p.id;
  };
  const late = Math.min(r.pick([0, 2, 5, 9]), size - 1);
  for (const [i, name] of NAMES.slice(0, size).entries()) await addProject(name, i < late ? -(i + 2) : i === late && r.chance(0.5) ? 3 : null);
  await addProject("Shopping", null, "list");
  if (index % 3 === 1) await addProject("Paperwork", null, "project", ids.get("Atlas"));
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const nameOf = (key: string) => {
    if (!isCard(key)) return SAID[key] ?? key.replaceAll("_", " ");
    const name = [...ids].find(([, pid]) => `project_card:${pid}` === key)?.[0] ?? "nothing";
    return kinds.get(key) === "list" ? `${name} list` : name;
  };
  const short = (key: string) => (isCard(key) ? nameOf(key) : key);

  // --- what the walker itself remembers ---------------------------------------
  const moves: string[] = [];
  const complaints: Complaint[] = [];
  const refusals = new Map<string, number>();
  const counts = new Map<string, number>();
  /** What he placed, in the order of the board he was last told, each with its place on that board. */
  let told: Told[] = [];
  const added = new Set<string>();
  const complain = (check: string, detail: string) => complaints.push({ check, detail: `step ${moves.length} (${moves.at(-1) ?? "start"}): ${detail}` });
  const refused = (reason: string) => {
    const kind = /urgent project/.test(reason) ? "an urgent card cannot be hidden" : /There's no|No section|no "|could be|already on the dashboard|Nothing to revert|Unknown section/i.test(reason) ? "no such section, or it is already there" : /added|cannot be unpinned/i.test(reason) ? "a section he added cannot be unpinned" : `OTHER: ${reason.replace(/"[^"]*"/g, '"…"').slice(0, 90)}`;
    refusals.set(kind, (refusals.get(kind) ?? 0) + 1);
  };

  // --- reading the state --------------------------------------------------------
  const prefs = () => getPreferences(id);
  const hiddenNow = async () => new Set((await prefs()).filter((p) => p.kind === "hide_section").map((p) => p.value.section));
  const bannedNow = async () => new Set((await prefs()).filter((p) => p.kind === "ban_component").map((p) => p.value.component));
  const head = async () => (await getPlanHead(id))!;
  const versions = async () => (await db.select({ v: layoutSpecs.version }).from(layoutSpecs).where(eq(layoutSpecs.userId, id))).length;
  const keysOf = (plan: LayoutPlan) => plan.sections.map(sectionKey);
  const marked = async () => {
    const h = await head();
    return (h.spec as LayoutPlan).sections.map((s) => `${short(sectionKey(s))}${s.place !== undefined ? `@${s.place}` : ""}${h.pinned.includes(sectionKey(s)) ? "*" : ""}`).join(" | ");
  };
  /** The source the next open's plan comes from, asked of the same chain an open uses. */
  const sourceNow = async (signals: Signals) => {
    const h = await head();
    return (await planWithFallback(signals, { previousPlan: h.spec as LayoutPlan, preferences: await prefs(), pinnedSections: h.pinned, llmEnabled: false })).source;
  };
  /** The places of what he placed, read off a board he was told: from the bottom when nothing upper stands below. */
  const readPlaces = (board: string[], placed: string[]): Told[] => {
    const body = board.filter((k) => k !== "focus_banner");
    const upper = (k: string) => !placed.includes(k) && (isCard(k) || ["hero_next_up", "stat_row", "timeline"].includes(k));
    return body
      .map((key, i) => ({ key, i }))
      .filter(({ key }) => placed.includes(key))
      .map(({ key, i }) => (body.slice(i + 1).some(upper) ? { key, from: "top" as const, n: i } : { key, from: "bottom" as const, n: body.length - 1 - i }));
  };

  // --- an open, and everything asked of it ----------------------------------------
  const open = async (why: string, opts: { mayStore: boolean; planner?: (signals: Signals) => LayoutPlan }) => {
    const before = await versions();
    const bundle = await computeCurrentPlan(id);
    await persistPlan(id, bundle, opts.planner ? { call: async () => {
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      return JSON.stringify(opts.planner!(bundle.signals));
    } } : {});
    const board = keysOf(bundle.plan);
    const body = board.filter((k) => k !== "focus_banner");
    const hidden = await hiddenNow();
    const banned = await bannedNow();
    const placedKeys = told.map((t) => t.key);
    const signals = bundle.signals;
    const urgent = new Set(signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const active = signals.projects.map((p) => `project_card:${p.id}`);

    // 1. A banner only first; nothing twice.
    if (board.indexOf("focus_banner") > 0) complain("1 banner first", `${why}: the banner is at ${board.indexOf("focus_banner")}`);
    if (new Set(board).size !== board.length) complain("1 nothing twice", `${why}: ${board.map(short).join(" ")}`);
    // 2. One card for every active top-level project unless he hid it; a hidden card only while urgent; none for anything else.
    for (const key of active) {
      const want = !banned.has("project_card") && (!hidden.has(key) || urgent.has(key));
      if (board.includes(key) !== want) complain("2 the cards", `${why}: ${short(key)} is ${board.includes(key) ? "drawn" : "missing"} (hidden=${hidden.has(key)} urgent=${urgent.has(key)})`);
    }
    for (const key of board.filter(isCard)) if (!active.includes(key)) complain("2 the cards", `${why}: a card for something that is not an active project`);
    // 3. The cards he did not place are in the default's order for today's data.
    const free = (list: string[]) => list.filter((k) => isCard(k) && !placedKeys.includes(k));
    const wantOrder = free(keysOf(defaultPlan(signals))).filter((k) => board.includes(k));
    if (free(board).join() !== wantOrder.join()) complain("3 cards by the data", `${why}: ${free(board).map(short).join(" ")} | by the data: ${wantOrder.map(short).join(" ")}`);
    // 4. The right way up: without the banner and what he placed, the cards are one run, next up and the tiles above it, needs a date and people below.
    const rest = body.filter((k) => !placedKeys.includes(k));
    const cardAt = rest.map((k, i) => (isCard(k) ? i : -1)).filter((i) => i >= 0);
    if (cardAt.length && cardAt.at(-1)! - cardAt[0] + 1 !== cardAt.length) complain("4 the right way up", `${why}: the cards are not one run: ${rest.map(short).join(" ")}`);
    if (cardAt.length) {
      for (const above of ["hero_next_up", "stat_row"]) if (rest.includes(above) && rest.indexOf(above) > cardAt[0]) complain("4 the right way up", `${why}: ${above} is under the cards: ${rest.map(short).join(" ")}`);
      for (const below of ["date_chase", "people_index"]) if (rest.includes(below) && rest.indexOf(below) < cardAt.at(-1)!) complain("4 the right way up", `${why}: ${below} is above the cards: ${rest.map(short).join(" ")}`);
    }
    // 5. What he placed is in the order he was told, each at its place, or after the end when the board is shorter.
    const here = told.filter((t) => board.includes(t.key));
    if (body.filter((k) => here.some((t) => t.key === k)).join() !== here.map((t) => t.key).join()) {
      complain("5 placed, in the order he was told", `${why}: ${body.filter((k) => placedKeys.includes(k)).map(short).join(" ")} | told: ${here.map((t) => short(t.key)).join(" ")}`);
    }
    const bottoms = here.filter((t) => t.from === "bottom").length;
    for (const t of here) {
      const at = body.indexOf(t.key);
      if (t.from === "bottom" && body.length > t.n && body.length - 1 - at !== t.n) complain("5 placed, at its place", `${why}: ${short(t.key)} was told ${t.n} from the bottom and is ${body.length - 1 - at} from it`);
      if (t.from === "top" && t.n < body.length - bottoms && at !== t.n) complain("5 placed, at its place", `${why}: ${short(t.key)} was told place ${t.n} and is at ${at}`);
    }
    // 6. Nothing he hid or banned is drawn, but an urgent card.
    for (const key of board) {
      if (hidden.has(key) && !urgent.has(key)) complain("6 hidden stays hidden", `${why}: ${short(key)}`);
      if (banned.has(key.split(":")[0])) complain("6 banned stays off", `${why}: ${short(key)}`);
    }
    // A. Everything that belongs on the board and is not hidden or banned is drawn.
    for (const key of [...DEFAULT_SECTIONS, ...added]) {
      if (!hidden.has(key) && !banned.has(key) && !board.includes(key)) complain("A what belongs is drawn", `${why}: ${key} is missing`);
    }
    // Calm mode: the default's emphasis, nothing accented, no reason given but a card being back.
    if (signals.context.calm_mode) {
      for (const s of bundle.plan.sections) {
        if (s.props?.accent === true || (s.why && !s.why.startsWith("Back on your board"))) complain("calm mode has no emphasis", `${why}: ${short(sectionKey(s))} ${s.why ?? "accent"}`);
      }
    }
    // An open with nothing changed writes nothing.
    const after = await versions();
    if (!opts.mayStore && after !== before) complain("an unchanged open stores nothing", `${why}: versions ${before} -> ${after}; stored: ${await marked()}`);
    // Composing the board that is stored gives that same board.
    const h = await head();
    const again = composePlan(h.spec as LayoutPlan, { signals, stored: h.spec as LayoutPlan, pinned: h.pinned, preferences: await prefs() });
    if (keysOf(again).join() !== keysOf(h.spec as LayoutPlan).join()) complain("composing the stored board gives the same board", `${why}: ${keysOf(h.spec as LayoutPlan).map(short).join(" ")} -> ${keysOf(again).map(short).join(" ")}`);
    return { board, bundle };
  };
  /** Two opens after every step: the second is the first again, and stores nothing. */
  const openTwice = async (why: string, opts: { firstMayStore: boolean; planner?: (signals: Signals) => LayoutPlan }) => {
    const first = await open(`${why}, first open`, { mayStore: opts.firstMayStore, planner: opts.planner });
    const second = await open(`${why}, second open`, { mayStore: false });
    if (first.board.join() !== second.board.join()) complain("the second open is the first", `${why}: ${first.board.map(short).join(" ")} | then ${second.board.map(short).join(" ")}`);
    return first;
  };

  // --- his requests ----------------------------------------------------------------
  /** After a request that was answered "applied": what the reply said, what was stored, and the next opens. */
  const afterRequest = async (what: string, reply: string[] | null, nowPlaced: string[], claim?: (board: string[]) => string | null) => {
    const stored = keysOf((await head()).spec as LayoutPlan);
    const heldBefore = await sourceNow((await computeCurrentPlan(id)).signals);
    told = readPlaces(reply ?? stored, nowPlaced.filter((k) => (reply ?? stored).includes(k)));
    const first = await openTwice(what, { firstMayStore: false });
    // 7. The board that was stored is the first open, section for section; and so is the reply.
    if (stored.join() !== first.board.join()) complain("7 the stored board is the next open", `${what}: stored ${stored.map(short).join(" ")} | open ${first.board.map(short).join(" ")}`);
    if (reply && reply.join() !== first.board.join()) complain("the reply is the next open", `${what}: reply ${reply.map(short).join(" ")} | open ${first.board.map(short).join(" ")}`);
    const said = claim?.(first.board);
    if (said) complain("the reply's own claim", `${what}: ${said}`);
    if (/unpin|hide|show|remove|add back/.test(what) && heldBefore === "previous") complain("his own unpin, hide or show does not hold the plan", what);
    // The same again on an open that is NOT a cache hit: something else in his data changes.
    const other = r.pick([...ids.keys()]);
    await db.insert(tasks).values({ userId: id, projectId: ids.get(other)!, title: `${other}: one more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
    const later = await openTwice(`${what}, then his data changes elsewhere`, { firstMayStore: true });
    const stillSaid = claim?.(later.board);
    if (stillSaid) complain("the reply's own claim, after his data changed elsewhere", `${what}: ${stillSaid}`);
  };
  const arrange = async (op: string, key: string) => {
    const before = keysOf((await computeCurrentPlan(id)).plan);
    const res = (await executeTool(ctx, "arrange_dashboard", { operations: [{ op, section: nameOf(key) }] })).result as { applied?: boolean; error?: string; order?: string[] };
    if (!res.applied) return refused(res.error ?? "no reason given");
    if (op === "hide") added.delete(key);
    const placedNow = op === "hide" ? told.map((t) => t.key).filter((k) => k !== key) : op === "show" ? told.map((t) => t.key) : [...new Set([...told.map((t) => t.key), key])];
    const body = before.filter((k) => k !== "focus_banner");
    const was = body.indexOf(key);
    const names = res.order ?? [];
    await afterRequest(`arrange ${op} ${short(key)}`, null, placedNow, (board) => {
      const b = board.filter((k) => k !== "focus_banner");
      if (op === "hide") return board.includes(key) ? "it said hidden and it is drawn" : null;
      if (!board.includes(key)) return "it said applied and the section is not on the board";
      if (op === "move_to_top" && b[0] !== key) return `it said to the top and it is at ${b.indexOf(key)}`;
      if (op === "move_to_bottom" && b.at(-1) !== key) return `it said to the bottom and it is ${b.length - 1 - b.indexOf(key)} from it`;
      if (op === "move_up" && was > 0 && b.indexOf(key) > b.indexOf(body[was - 1]) && b.includes(body[was - 1])) return `it said up one and ${short(body[was - 1])} is still above it`;
      if (op === "move_down" && was >= 0 && was < body.length - 1 && b.includes(body[was + 1]) && b.indexOf(key) < b.indexOf(body[was + 1])) return `it said down one and ${short(body[was + 1])} is still below it`;
      return null;
    });
    // What the tool read back is the board the next open shows.
    const shown = await boardSectionNames(id, (await computeCurrentPlan(id)).plan);
    if (names.length && names.join("|") !== shown.join("|") && !moves.at(-1)?.includes("then")) {
      // (The data changed once since the reply; only the names he was told about are compared.)
      const common = shown.filter((n) => names.includes(n));
      if (names.filter((n) => shown.includes(n)).join("|") !== common.join("|")) complain("the reply is the next open", `arrange ${op}: read back ${names.join(" · ")} | shown ${shown.join(" · ")}`);
    }
  };
  const edit = async (what: string, operation: Record<string, unknown>, key: string, placedNow: (now: string[]) => string[], claim?: (board: string[]) => string | null) => {
    const res = (await executeTool(ctx, "edit_layout_plan", { operations: [operation] })).result as { applied?: boolean; error?: string; sections?: string[] };
    if (!res.applied) return refused(res.error ?? "no reason given");
    await afterRequest(`${what} ${short(key)}`, res.sections ?? null, placedNow(told.map((t) => t.key)), claim);
  };
  const route = async (body: Record<string, unknown>) => {
    session.user = me;
    const res = await layoutRoute(new Request("http://localhost/api/layout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { ok: res.ok, json: (await res.json()) as { error?: string } };
  };

  // --- the walk ------------------------------------------------------------------------
  await openTwice("the first open", { firstMayStore: true });
  for (let step = 0; step < STEPS; step++) {
    const board = keysOf((await computeCurrentPlan(id)).plan).filter((k) => k !== "focus_banner");
    const hidden = [...(await hiddenNow())];
    const draw = r.next();
    const count = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (draw < 0.3) {
      // arrange_dashboard, biased toward what he already placed and its neighbours, so places meet.
      const op = r.pick(["move_to_top", "move_up", "move_up", "move_down", "move_down", "move_to_bottom", "hide", "hide", "show"] as const);
      const near = told.flatMap((t) => [board[board.indexOf(t.key) - 1], t.key, board[board.indexOf(t.key) + 1]]).filter((k): k is string => !!k);
      const key = op === "show" && hidden.length ? r.pick(hidden) : near.length && r.chance(0.6) ? r.pick(near) : r.pick([...board, ...hidden]);
      moves.push(`arrange ${op} ${short(key)}`);
      count(`arrange ${op}`);
      await arrange(op, key);
    } else if (draw < 0.47) {
      const kind = r.pick(["move", "move", "remove", "add back", "add new"] as const);
      count(`edit ${kind}`);
      if (kind === "move") {
        const key = r.pick(board);
        const pinnedAt = told.length && r.chance(0.5) ? board.indexOf(r.pick(told).key) : -1;
        const to = pinnedAt >= 0 ? pinnedAt : r.int(board.length + 3);
        moves.push(`edit move ${short(key)} to ${to}`);
        await edit("edit move", { op: "move", section: key, to }, key, (now) => [...new Set([...now, key])], (b) => (b.includes(key) ? null : "it said applied and the section is not on the board"));
      } else if (kind === "remove") {
        const key = r.pick(board);
        moves.push(`edit remove ${short(key)}`);
        added.delete(key);
        await edit("edit remove", { op: "remove", section: key }, key, (now) => now.filter((k) => k !== key), (b) => (b.includes(key) ? "it said removed and it is drawn" : null));
      } else if (kind === "add back" && hidden.length) {
        const key = r.pick(hidden);
        moves.push(`edit add back ${short(key)}`);
        const operation = isCard(key) ? { op: "add", component: "project_card", props: { project_id: key.slice(13) }, at: r.int(4) } : { op: "add", component: key, at: r.int(4) };
        await edit("edit add back", operation, key, (now) => now, (b) => (b.includes(key) ? null : "it said applied and the section is not on the board"));
      } else {
        const key = r.pick(ADDABLE);
        const at = r.int(board.length + 1);
        moves.push(`edit add new ${key} at ${at}`);
        const before = (await head()).version;
        await edit("edit add new", { op: "add", component: key, at }, key, (now) => [...new Set([...now, key])], (b) => (b.includes(key) ? null : "it said applied and the section is not on the board"));
        if ((await head()).version !== before) added.add(key);
      }
    } else if (draw < 0.55) {
      // The pin button: pin or unpin, on anything on the board.
      const key = r.pick(board);
      const pinned = !(await head()).pinned.includes(key);
      moves.push(`${pinned ? "pin" : "unpin"} ${short(key)}`);
      count(pinned ? "pin button: pin" : "pin button: unpin");
      const res = await route({ action: "pin", component: key, pinned });
      if (!res.ok) refused(res.json.error ?? "no reason given");
      else {
        const stays = !pinned && added.has(key); // a section he added is always placed
        await afterRequest(`${pinned ? "pin" : "unpin"} ${short(key)}`, null, pinned || stays ? [...new Set([...told.map((t) => t.key), key])] : told.map((t) => t.key).filter((k) => k !== key));
      }
    } else if (draw < 0.59) {
      moves.push("put it back");
      count("put it back");
      const res = await route({ action: "revert" });
      if (!res.ok) refused(res.json.error ?? "no reason given");
      else {
        // The earlier board and its pins: the walker reads what he is told now from the row itself.
        const h = await head();
        told = readPlaces(keysOf(h.spec as LayoutPlan), h.pinned);
        await openTwice("put it back", { firstMayStore: true });
      }
    } else if (draw < 0.62) {
      const enabled = !(await computeCurrentPlan(id)).signals.context.calm_mode;
      moves.push(`calm mode ${enabled ? "on" : "off"}`);
      count("calm mode");
      await route({ action: "calm_mode", enabled });
      await openTwice("calm mode", { firstMayStore: true });
    } else if (draw < 0.66) {
      // Settings lifts a hide or a ban: the preference is deleted, nothing else is told.
      const all = (await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, id))).filter((p) => p.kind === "hide_section" || p.kind === "ban_component");
      if (all.length) {
        const pref = r.pick(all);
        moves.push(`settings lifts ${pref.kind} ${Object.values(pref.value as Record<string, string>)[0].slice(0, 30)}`);
        count("settings lifts a preference");
        await route({ action: "remove_preference", id: pref.id });
        await openTwice("settings lifts a preference", { firstMayStore: true });
      }
    } else if (draw < 0.69) {
      const banned = [...(await bannedNow())];
      const component = banned.length && r.chance(0.5) ? r.pick(banned) : r.pick(["people_index", "stat_row", "kanban", "date_chase"]);
      const remove = banned.includes(component);
      moves.push(`${remove ? "unban" : "ban"} ${component}`);
      count(remove ? "unban" : "ban");
      const res = (await executeTool(ctx, "set_layout_preference", { kind: "ban_component", component, ...(remove ? { remove: true } : {}) })).result as { error?: string };
      if (res.error) refused(res.error);
      else {
        if (!remove) told = told.filter((t) => t.key !== component);
        const first = await openTwice(`${remove ? "unban" : "ban"} ${component}`, { firstMayStore: true });
        if (!remove && (await sourceNow(first.bundle.signals)) === "previous") complain("a ban alone does not hold the plan", component);
      }
    } else if (draw < 0.74) {
      moves.push("the next day");
      count("the next day");
      await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
      clearPlanCache();
      await openTwice("the next day", { firstMayStore: true });
    } else if (draw < 0.8) {
      const strip = r.chance(0.4);
      moves.push(`a planner answer lands: a banner${strip ? " and the strip to the top" : ""}`);
      count("a planner answer");
      await db.insert(tasks).values({ userId: id, projectId: ids.get(r.pick([...ids.keys()]))!, title: `for the planner ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
      await open("the planner is asked", { mayStore: true, planner: (signals) => {
        const plan = defaultPlan(signals);
        const rest = plan.sections.filter((s) => s.component !== "timeline");
        const sections = strip ? [{ component: "timeline", props: { span_days: 14, expanded: true }, why: "Dates first this week" }, ...rest] : plan.sections;
        return { ...plan, plan_id: "p", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Several things are late", tone: "serious" } }, ...sections] };
      } });
      await openTwice("after the planner's answer", { firstMayStore: true });
    } else {
      // His data.
      const names = [...ids.keys()];
      const kind = r.pick(["task", "task", "redate", "archive", "new project"] as const);
      count(`data: ${kind}`);
      if (kind === "task") {
        const name = r.pick(names);
        const due = r.pick([-6, -1, 2, 20, null]);
        moves.push(`data: a task on ${name} due ${due}`);
        await db.insert(tasks).values({ userId: id, projectId: ids.get(name)!, title: `${name}: more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
      } else if (kind === "redate") {
        const name = r.pick(names);
        const due = r.pick([-9, 5, 30, null]);
        moves.push(`data: every date of ${name} set to ${due}`);
        await db.update(tasks).set({ dueAt: due === null ? null : day(due) }).where(and(eq(tasks.userId, id), eq(tasks.projectId, ids.get(name)!)));
      } else if (kind === "archive" && names.length > Math.min(5, size)) {
        const name = r.pick(names.filter((n) => n !== "Shopping"));
        moves.push(`data: ${name} archived`);
        await db.update(projects).set({ status: "archived" }).where(eq(projects.id, ids.get(name)!));
        told = told.filter((t) => t.key !== `project_card:${ids.get(name)}`);
        ids.delete(name);
      } else {
        const name = NEW_NAMES.find((n) => !ids.has(n));
        if (name) {
          const due = r.pick([null, -4, 4]);
          moves.push(`data: a new project ${name} due ${due}`);
          await addProject(name, due);
        }
      }
      await openTwice("his data changed", { firstMayStore: true });
    }
  }
  const other = [...refusals].filter(([reason]) => reason.startsWith("OTHER"));
  for (const [reason, n] of other) complaints.push({ check: "a refusal for a reason that is not one of the three", detail: `${n} x ${reason}` });
  return { complaints, moves, counts, refusals, size, storedBoard: await marked() };
}

afterAll(async () => {
  if (users.length) await db.delete(user).where(inArray(user.id, users));
});

describe(`a random walk over the Overview (${WALKS} walks of ${STEPS} steps, seed ${SEED})`, { timeout: 600_000 }, () => {
  const tally = new Map<string, number>();
  const reached = new Map<string, number>();
  const refusedFor = new Map<string, number>();

  it.each(Array.from({ length: WALKS }, (_, i) => i))("walk %i", async (index) => {
    clearPlanCache();
    const result = await walk(index);
    for (const c of result.complaints) tally.set(c.check, (tally.get(c.check) ?? 0) + 1);
    for (const [k, n] of result.counts) reached.set(k, (reached.get(k) ?? 0) + n);
    for (const [k, n] of result.refusals) refusedFor.set(k, (refusedFor.get(k) ?? 0) + n);
    if (result.complaints.length) {
      console.log(
        [`WALK ${index} (seed ${SEED}, a board of ${result.size}): ${result.complaints.length} complaint(s)`, ...result.complaints.slice(0, 6).map((c) => `  [${c.check}] ${c.detail}`), `  the last six moves: ${result.moves.slice(-6).join(" ; ")}`, `  the stored board (@place, *pinned): ${result.storedBoard}`].join("\n")
      );
    }
    expect(result.complaints.map((c) => c.check)).toEqual([]);
  });

  afterAll(() => {
    console.log(
      ["WALK TALLY", `  complaints by check: ${JSON.stringify(Object.fromEntries(tally))}`, `  moves reached: ${JSON.stringify(Object.fromEntries([...reached].toSorted()))}`, `  refusals by reason: ${JSON.stringify(Object.fromEntries(refusedFor))}`].join("\n")
    );
  });
});

// The chip under a deadline against the words the date beside it uses
// (lib/due.ts), with the clock moved across midnight and across the due hour,
// for a committed deadline ahead, today and past.
describe("the chip under a committed deadline says what the date beside it says", { timeout: 60_000 }, () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["ahead", "2026-11-13T01:00:00Z"],
    ["today", "2026-11-11T01:00:00Z"],
    ["past", "2026-11-08T01:00:00Z"],
  ])("a deadline %s, seen the evening before midnight, the next morning, and after its hour", async (_what, deadline) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = `test-walk-${crypto.randomUUID()}`;
    users.push(id);
    vi.setSystemTime(new Date("2026-11-10T05:54:00Z")); // Nov 9, 21:54 in Los Angeles
    await db.insert(user).values({ id, name: "Chip", email: `${id}@v102.test`, timezone: TZ });
    const [p] = await db.insert(projects).values({ userId: id, name: "Report", status: "active", deadline: new Date(deadline), deadlineKind: "committed" }).returning();
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: "Send the report", status: "todo", source: "spoken" });
    const seen: string[] = [];
    for (const now of ["2026-11-10T05:54:00Z", "2026-11-10T17:00:00Z", "2026-11-11T01:30:00Z", "2026-11-12T17:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      for (let open = 0; open < 2; open++) {
        const bundle = await computeCurrentPlan(id);
        await persistPlan(id, bundle);
        const why = bundle.plan.sections.find((s) => s.props?.project_id === p.id)?.why;
        const beside = dueLabel(new Date(deadline), TZ, new Date(now));
        if (!why) continue; // rule 1 is not firing for it now: no chip, nothing to disagree
        const says = /late/.test(why) ? why.match(/\d+ days? late/)?.[0] : /^Due today/.test(why) ? "today" : /^Due tomorrow/.test(why) ? "tomorrow" : `in ${why.match(/\d+/)?.[0]} days`;
        const wants = /late|today|tomorrow/.test(beside) ? beside : `in ${Math.round((new Date(deadline).getTime() - new Date(now).getTime()) / 86_400_000)} days`;
        if (/late|today|tomorrow/.test(beside) ? says !== beside : !/^in \d+ days$/.test(says ?? "")) seen.push(`at ${now}: the chip says "${why}", the date beside it says "${beside}" (${wants})`);
      }
    }
    expect(seen).toEqual([]);
  });
});
