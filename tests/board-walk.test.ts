// The gate for the Overview's composition (SPEC §2, v1.02 r5): a seeded random
// walk over everything that can change the board, with the same questions
// asked after every step. Three rounds were offered on examples and failed on
// a state no example had: two sections he placed meeting at one place on a
// board that had since grown shorter. Examples cannot be the gate again.
//
// THE WALKER HAS A MODEL OF ITS OWN. Before a request it opens the board
// itself, applies the request to that list the plain way (up and down swap
// with the neighbour; the top is the first place under the banner; the bottom
// is the end; remove; insert at n) and requires the reply to be that board,
// section for section. What he placed, and where, is read off that EXPECTED
// board, never off what the product stored. For show, add-back and unpin the
// model can only say "where the system has it": there it asks that the
// section is drawn, that everything else kept its order, and the standing
// questions. It keeps its own history, one entry per stored version, and
// after "Put it back" expects the entry before.
//
// Everything goes through the real paths: both tools and the preference tool
// through the tool executor, an open as compute-then-store, the pin button,
// Put it back, calm mode and the Settings route that lifts a preference
// through their route handler. Their limits, accepted and named here:
// - the planner's ANSWER is put in through persistPlan's `call` seam (the
//   budget is $0); everything after the answer is the real code. A planner's
//   plan served again from the in-memory cache is not reached by the walk; it
//   is covered by tests/composition-paths.test.ts only;
// - the route handlers run with a faked session;
// - "the next day" is stored versions made two days old; the chip's own test
//   (at the end of this file) moves the clock with a faked Date, because a
//   browser's clock can be moved and the server's cannot.
//
// BOARD_WALKS, BOARD_STEPS and BOARD_SEED size the run; BOARD_PRINT=all
// prints every complaint. The suite runs a small one; the long one
// (BOARD_WALKS=120 BOARD_STEPS=30) is run before an offer. A failing walk
// prints its complaints, its last six moves and the stored board, each place
// and pin marked.
process.env.TZ = "UTC";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";

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
import { conversations, layoutPreferences, layoutSpecs, messages, projects, tasks, user } from "@/lib/db/schema";
import { daysFromToday } from "@/lib/due";
import { composePlan } from "@/lib/layout/compose";
import { defaultPlan, isUrgent, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage, planWithFallback } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import type { Signals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { POST as layoutRoute } from "@/app/api/layout/route";

const TZ = "America/Los_Angeles";
const WALKS = Number(process.env.BOARD_WALKS ?? 8);
const STEPS = Number(process.env.BOARD_STEPS ?? 16);
const SEED = Number(process.env.BOARD_SEED ?? 20261013);
const PRINT_ALL = process.env.BOARD_PRINT === "all";
const NAMES = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris"];
const NEW_NAMES = ["Juniper", "Kestrel", "Larch", "Maple", "Nettle", "Oakum", "Pippin", "Quince"];
/** What the voice tool calls each section when it reads the board back (lib/layout/arrange.ts). */
const SAID: Record<string, string> = { focus_banner: "banner", hero_next_up: "next up", stat_row: "stats", timeline: "project progress", date_chase: "needs a date", people_index: "people", kanban: "kanban", coming_up: "coming up", documents: "documents", suggested_zone: "suggestions" };
const DEFAULT_SECTIONS = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const ADDABLE = ["kanban", "coming_up", "documents", "suggested_zone"];
const BANNER = "focus_banner";
const MARK = "[walk]";
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

// --- the model: plain operations on a list of section keys ---------------------
type Told = { key: string; from: "top" | "bottom"; n: number };
const bannerFirst = (list: string[]) => (list.includes(BANNER) ? [BANNER, ...list.filter((k) => k !== BANNER)] : list);
const without = (list: string[], key: string) => list.filter((k) => k !== key);
const insertAt = (list: string[], key: string, at: number) => [...list.slice(0, Math.min(at, list.length)), key, ...list.slice(Math.min(at, list.length))];
/** The voice tool's operation on the board he sees. Null: the model cannot say where (it goes where the system has it). */
function arrangeModel(board: string[], op: string, key: string): string[] | null {
  const banner = board.includes(BANNER) ? [BANNER] : [];
  const body = without(board, BANNER);
  const here = body.includes(key);
  if (op === "hide") return [...banner, ...without(body, key)];
  if (op === "show") return here ? board : null;
  if (op === "move_to_top") return [...banner, key, ...without(body, key)];
  if (op === "move_to_bottom") return [...banner, ...without(body, key), key];
  if (!here) return null; // brought onto the board first, then moved by one from there
  const i = body.indexOf(key);
  const j = op === "move_up" ? i - 1 : i + 1;
  if (j < 0 || j >= body.length) return board;
  const next = [...body];
  [next[i], next[j]] = [next[j], next[i]];
  return [...banner, ...next];
}
/** The chat tool's operation on the plan as get_current_plan numbers it (the banner is position 0 when there is one). */
function editModel(board: string[], operation: { op: string; section?: string; component?: string; to?: number; at?: number }, key: string): string[] {
  if (operation.op === "move") return bannerFirst(insertAt(without(board, key), key, operation.to ?? 0));
  if (operation.op === "remove") return without(board, key);
  if (operation.op === "add") return bannerFirst(insertAt(board, key, operation.at ?? board.length));
  return board; // set_props
}
/** The places of what he placed, read off a board he was told: from the bottom when nothing upper stands below. */
function readPlaces(board: string[], placed: string[]): Told[] {
  const body = without(board, BANNER);
  const upper = (k: string) => !placed.includes(k) && (isCard(k) || ["hero_next_up", "stat_row", "timeline"].includes(k));
  return body
    .map((key, i) => ({ key, i }))
    .filter(({ key }) => placed.includes(key))
    .map(({ key, i }) => (body.slice(i + 1).some(upper) ? { key, from: "top" as const, n: i } : { key, from: "bottom" as const, n: body.length - 1 - i }));
}
/**
 * Where what he placed must stand among today's other sections: top-counted
 * in place order at their place, then bottom-counted at theirs from the end;
 * on a board too short, in the order he was told, never in front of one
 * already put in.
 */
function placeInto(flow: string[], told: Told[]): string[] {
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
const canon = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canon) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)])) : value;
/** A board as whole sections: the component, its props, its why and its place. */
const whole = (plan: LayoutPlan) => plan.sections.map((s) => JSON.stringify(canon([sectionKey(s), s.props ?? {}, s.why ?? null, s.place ?? null])));

type Complaint = { check: string; detail: string };

async function walk(index: number) {
  const r = rng(SEED + index * 7919);
  const size = [9, 5, 3, 9, 1, 0][index % 6];
  const id = `test-walk-${crypto.randomUUID()}`;
  users.push(id);
  const me = { id, email: `${id}@v102.test`, name: "Walker", timezone: TZ };
  await db.insert(user).values({ id, name: me.name, email: me.email, timezone: TZ });
  const ids = new Map<string, string>(); // name -> id, active top-level projects and lists
  const archived = new Map<string, string>();
  const kinds = new Map<string, "project" | "list">();
  let subproject: string | null = null;
  const addProject = async (name: string, due: number | null, kind: "project" | "list" = "project", parentId?: string) => {
    const [p] = await db.insert(projects).values({ userId: id, name, kind, status: "active", parentId }).returning();
    if (!parentId) {
      ids.set(name, p.id);
      kinds.set(`project_card:${p.id}`, kind);
    }
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
    return p.id;
  };
  const late = Math.min(r.pick([0, 2, 5, 9]), Math.max(0, size - 1));
  for (const [i, name] of NAMES.slice(0, size).entries()) await addProject(name, i < late ? -(i + 2) : i === late && r.chance(0.5) ? 3 : null);
  await addProject("Shopping", null, "list");
  if (index % 3 === 1 && ids.has("Atlas")) {
    await addProject("Paperwork", null, "project", ids.get("Atlas"));
    subproject = "Paperwork";
  }
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const allIds = () => new Map([...ids, ...archived]);
  const nameOf = (key: string) => {
    if (!isCard(key)) return SAID[key] ?? key.replaceAll("_", " ");
    const name = [...allIds()].find(([, pid]) => `project_card:${pid}` === key)?.[0] ?? "nothing";
    return kinds.get(key) === "list" ? `${name} list` : name;
  };
  const short = (key: string) => (isCard(key) ? nameOf(key) : key);
  const row = (list: string[]) => list.map(short).join(" ");

  // --- what the walker itself remembers ---------------------------------------
  const moves: string[] = [];
  const complaints: Complaint[] = [];
  const refusals = new Map<string, number>();
  const counts = new Map<string, number>();
  /** What he placed, each with its place on the board he was last told. */
  let told: Told[] = [];
  /** Components he added. One he hides is still his: shown again, it comes back placed. */
  const added = new Set<string>();
  /** One entry per stored version: what he had placed, and where, when it was stored. */
  const history: Told[][] = [];
  const complain = (check: string, detail: string) => complaints.push({ check, detail: `step ${moves.length} (${moves.at(-1) ?? "start"}): ${detail}` });
  const blank = (reason: string) => reason.replace(/"[^"]*"/g, '"…"').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "<id>").slice(0, 110);
  /** A refusal: one the walker expected, by its reason, or a complaint. */
  const refused = (reason: string, expected: string | null) => {
    if (expected) refusals.set(expected, (refusals.get(expected) ?? 0) + 1);
    else complain("refused, and the walker had no reason to expect it", blank(reason));
    if (/project_card:|[0-9a-f]{8}-[0-9a-f]{4}/.test(reason)) complain("a reply shows a raw key", blank(reason));
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
  /** Where the next open's plan would come from if it were not served from the stored row: the chain an open uses. */
  const sourceNow = async () => {
    const h = await getPlanHead(id);
    const signals = (await computeCurrentPlan(id)).signals;
    return (await planWithFallback(signals, { previousPlan: h ? (h.spec as LayoutPlan) : null, preferences: await prefs(), pinnedSections: h?.pinned ?? [], llmEnabled: false })).source;
  };
  /** The walker's history keeps step with the stored versions. */
  const remember = async () => {
    const n = await versions();
    while (history.length < n) history.push(told.map((t) => ({ ...t })));
  };

  // --- an open, and everything asked of it ----------------------------------------
  const open = async (why: string, opts: { mayStore: boolean; planner?: (signals: Signals) => string; retell?: string[] }) => {
    const before = await versions();
    const bundle = await computeCurrentPlan(id);
    // The model could not say where a section went (it is where the system has it): what he placed is read off this board.
    if (opts.retell) told = readPlaces(keysOf(bundle.plan), opts.retell.filter((k) => keysOf(bundle.plan).includes(k)));
    await persistPlan(id, bundle, opts.planner ? { call: async () => {
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      return opts.planner!(bundle.signals);
    } } : {});
    const board = keysOf(bundle.plan);
    const body = without(board, BANNER);
    const hidden = await hiddenNow();
    const banned = await bannedNow();
    const signals = bundle.signals;
    const urgent = new Set(signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const active = signals.projects.map((p) => `project_card:${p.id}`);
    const here = told.filter((t) => board.includes(t.key));
    const placedKeys = told.map((t) => t.key);

    // 1. A banner only first; nothing twice.
    if (board.indexOf(BANNER) > 0) complain("1 banner first", `${why}: the banner is at ${board.indexOf(BANNER)}`);
    if (new Set(board).size !== board.length) complain("1 nothing twice", `${why}: ${row(board)}`);
    // 2. One card for every active top-level project unless he hid it; a hidden card only while urgent; none for anything else.
    for (const key of active) {
      const want = !banned.has("project_card") && (!hidden.has(key) || urgent.has(key));
      if (board.includes(key) !== want) complain("2 the cards", `${why}: ${short(key)} is ${board.includes(key) ? "drawn" : "missing"} (hidden=${hidden.has(key)} urgent=${urgent.has(key)})`);
    }
    for (const key of board.filter(isCard)) if (!active.includes(key)) complain("2 the cards", `${why}: a card for something that is not an active project`);
    // 3. The cards he did not place are in the default's order for today's data.
    const free = (list: string[]) => list.filter((k) => isCard(k) && !placedKeys.includes(k));
    const byData = free(keysOf(defaultPlan(signals))).filter((k) => board.includes(k));
    if (free(board).join() !== byData.join()) complain("3 cards by the data", `${why}: ${row(free(board))} | by the data: ${row(byData)}`);
    // 4. The right way up: without the banner and what he placed, the cards are one run, next up and the tiles above it, needs a date and people below.
    const rest = body.filter((k) => !placedKeys.includes(k));
    const cardAt = rest.map((k, i) => (isCard(k) ? i : -1)).filter((i) => i >= 0);
    if (cardAt.length && cardAt.at(-1)! - cardAt[0] + 1 !== cardAt.length) complain("4 the right way up", `${why}: the cards are not one run: ${row(rest)}`);
    if (cardAt.length) {
      for (const above of ["hero_next_up", "stat_row"]) if (rest.includes(above) && rest.indexOf(above) > cardAt[0]) complain("4 the right way up", `${why}: ${above} is under the cards: ${row(rest)}`);
      for (const below of ["date_chase", "people_index"]) if (rest.includes(below) && rest.indexOf(below) < cardAt.at(-1)!) complain("4 the right way up", `${why}: ${below} is above the cards: ${row(rest)}`);
    }
    // 5. What he placed stands where the rule puts it among today's other sections: exactly.
    const expected = placeInto(rest, here);
    if (expected.join() !== body.join()) complain("5 what he placed is at its place", `${why}: ${row(body)} | the rule: ${row(expected)} | told: ${here.map((t) => `${short(t.key)}=${t.from}${t.n}`).join(" ")}`);
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
    // Composing the board that is stored gives that same board: whole sections, not only their order.
    const h = await head();
    const stored = h.spec as LayoutPlan;
    const again = composePlan(stored, { signals, stored, pinned: h.pinned, preferences: await prefs() });
    if (whole(again).join() !== whole(stored).join()) {
      const at = whole(again).findIndex((s, i) => s !== whole(stored)[i]);
      complain("composing the stored board gives the same board", `${why}: first difference at ${at}: stored ${whole(stored)[at] ?? "nothing"} | composed ${whole(again)[at] ?? "nothing"}`);
    }
    await remember();
    return { board, bundle };
  };
  /** Two opens after every step: the second is the first again, whole sections, and stores nothing. */
  const openTwice = async (why: string, opts: { firstMayStore: boolean; planner?: (signals: Signals) => string; retell?: string[] }) => {
    const first = await open(`${why}, first open`, { mayStore: opts.firstMayStore, planner: opts.planner, retell: opts.retell });
    const second = await open(`${why}, second open`, { mayStore: false });
    if (whole(first.bundle.plan).join() !== whole(second.bundle.plan).join()) {
      const at = whole(first.bundle.plan).findIndex((s, i) => s !== whole(second.bundle.plan)[i]);
      complain("the second open is the first", `${why}: first difference at ${at}: ${whole(first.bundle.plan)[at] ?? "nothing"} | then ${whole(second.bundle.plan)[at] ?? "nothing"}`);
    }
    return first;
  };

  // --- his requests ----------------------------------------------------------------
  /**
   * After a request answered "applied". `expected` is the board the model
   * says he must be told, or null when it can only say which section came or
   * went (`subject`): then everything else must have kept its order.
   */
  const afterRequest = async (what: string, before: string[], expected: string[] | null, subject: string[], reply: string[] | null, placedNow: string[], heldBefore: string, extra?: (first: LayoutPlan) => string | null) => {
    const stored = keysOf((await head()).spec as LayoutPlan);
    // What he placed, and where, is read off the board the request asks for (the model's) BEFORE the product is opened.
    if (expected) told = readPlaces(expected, placedNow.filter((k) => expected.includes(k)));
    const first = await openTwice(what, { firstMayStore: false, retell: expected ? undefined : placedNow });
    const board = first.board;
    if (expected) {
      if (reply && reply.join() !== expected.join()) complain("the reply is the board the request asks for", `${what}: reply ${row(reply)} | asked ${row(expected)}`);
      if (board.join() !== expected.join()) complain("the next open is the board the request asks for", `${what}: open ${row(board)} | asked ${row(expected)}`);
    } else {
      const others = (list: string[]) => list.filter((k) => !subject.includes(k));
      if (others(board).join() !== others(before).join()) complain("everything else kept its order", `${what}: ${row(others(board))} | before ${row(others(before))}`);
    }
    if (reply && reply.join() !== board.join()) complain("the reply is the next open", `${what}: reply ${row(reply)} | open ${row(board)}`);
    // 7. The board that was stored is the first open, section for section.
    if (stored.join() !== board.join()) complain("7 the stored board is the next open", `${what}: stored ${row(stored)} | open ${row(board)}`);
    const said = extra?.(first.bundle.plan);
    if (said) complain("the reply's own claim", `${what}: ${said}`);
    history[history.length - 1] = told.map((t) => ({ ...t }));
    if (heldBefore !== "previous" && (await sourceNow()) === "previous") complain("his own request does not hold the plan", what);
    // The same again on an open that is NOT served from the stored row: something else in his data changes.
    const names = [...ids.keys()];
    if (names.length) {
      const other = r.pick(names);
      await db.insert(tasks).values({ userId: id, projectId: ids.get(other)!, title: `${other}: one more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
      await openTwice(`${what}, then his data changes elsewhere`, { firstMayStore: true });
    }
  };
  const route = async (body: Record<string, unknown>) => {
    session.user = me;
    const res = await layoutRoute(new Request("http://localhost/api/layout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { ok: res.ok, json: (await res.json()) as { error?: string } };
  };
  const boardNow = async () => keysOf((await computeCurrentPlan(id)).plan);
  const placedSet = () => told.map((t) => t.key);

  /** One or more operations by voice in one request; the last word about a section wins. */
  const arrange = async (ops: { op: string; key: string }[]) => {
    const before = await boardNow();
    const hidden = await hiddenNow();
    const urgent = new Set((await computeCurrentPlan(id)).signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const heldBefore = await sourceNow();
    let model: string[] | null = before;
    let placedNow = placedSet();
    const subject: string[] = [];
    let expectRefusal: string | null = null;
    for (const { op, key } of ops) {
      const onBoard = (model ?? before).includes(key);
      if (op === "hide" && isCard(key) && urgent.has(key)) expectRefusal ??= "an urgent card cannot be hidden";
      if (op === "hide" && !onBoard) expectRefusal ??= "hiding what is already hidden";
      subject.push(key);
      model = model ? arrangeModel(model, op, key) : null;
      if (op === "hide") placedNow = without(placedNow, key);
      else if (op !== "show") placedNow = [...new Set([...placedNow, key])];
      else if (added.has(key)) placedNow = [...new Set([...placedNow, key])]; // a section he added comes back placed
      if (op === "show" && added.has(key) && hidden.has(key) && model === null) model = [...without(before, key), key]; // at the end
    }
    const res = (await executeTool(ctx, "arrange_dashboard", { operations: ops.map((o) => ({ op: o.op, section: nameOf(o.key) })) })).result as { applied?: boolean; error?: string; order?: string[] };
    if (!res.applied) return refused(res.error ?? "no reason given", expectRefusal);
    const what = `arrange ${ops.map((o) => `${o.op} ${short(o.key)}`).join(" + ")}`;
    await afterRequest(what, before, model, subject, null, placedNow, heldBefore, (first) => {
      // What it read back is the first open, name for name.
      const names = keysOf(first).map((k) => nameOf(k));
      return (res.order ?? []).join("|") === names.join("|") ? null : `it read back ${(res.order ?? []).join(" · ")} and the open shows ${names.join(" · ")}`;
    });
  };
  /** One or more operations in the chat tool in one request. */
  const edit = async (operations: { op: string; section?: string; component?: string; props?: Record<string, unknown>; to?: number; at?: number }[]) => {
    const before = await boardNow();
    const hidden = await hiddenNow();
    const urgent = new Set((await computeCurrentPlan(id)).signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const heldBefore = await sourceNow();
    let model: string[] | null = before;
    let placedNow = placedSet();
    const subject: string[] = [];
    let expectRefusal: string | null = null;
    let sized: { key: string; variant: string } | null = null;
    for (const o of operations) {
      const key = o.op === "add" ? (o.component === "project_card" ? `project_card:${String(o.props?.project_id)}` : o.component!) : o.section!;
      const onBoard = (model ?? before).includes(key);
      subject.push(key);
      if (o.op === "add") {
        if (onBoard) expectRefusal ??= "adding what is already on the board";
        else if (isCard(key) && !ids.has(nameOf(key).replace(/ list$/, ""))) expectRefusal ??= "a card for something that is not on the board";
        else if (hidden.has(key) && !added.has(key)) model = null; // a show: where the system has it
        else {
          model = model ? editModel(model, o, key) : null; // a new component, or one he added and hid: placed
          placedNow = [...new Set([...placedNow, key])];
          added.add(key);
        }
        continue;
      }
      if (!onBoard) {
        expectRefusal ??= "a section that is not on the board";
        continue;
      }
      if (o.op === "remove") {
        if (isCard(key) && urgent.has(key)) expectRefusal ??= "an urgent card cannot be hidden";
        placedNow = without(placedNow, key);
      }
      if (o.op === "move") placedNow = [...new Set([...placedNow, key])];
      if (o.op === "set_props") sized = { key, variant: String(o.props?.variant) };
      model = model ? editModel(model, o, key) : null;
    }
    const res = (await executeTool(ctx, "edit_layout_plan", { operations })).result as { applied?: boolean; error?: string; sections?: string[]; size_note?: string };
    if (!res.applied) return refused(res.error ?? "no reason given", expectRefusal);
    if (expectRefusal === "an urgent card cannot be hidden") complain("hiding an urgent card was applied", operations.map((o) => o.op).join("+"));
    const what = `edit ${operations.map((o) => `${o.op} ${short(o.section ?? o.component ?? "")}${o.to !== undefined ? ` to ${o.to}` : ""}${o.at !== undefined ? ` at ${o.at}` : ""}`).join(" + ")}`;
    await afterRequest(what, before, model, subject, res.sections ?? null, placedNow, heldBefore, (first) => {
      if (!sized) return null;
      if (!res.size_note) return "a size was set and the reply does not say it is for now";
      const card = first.sections.find((s) => sectionKey(s) === sized!.key);
      return card?.props?.variant === sized.variant ? null : `it said the size was set and the next open has ${String(card?.props?.variant)}`;
    });
  };
  /** The pin button, or the preference tool's pin: the section is his where it stands; unpinned, it goes where the system has it. */
  const pin = async (key: string, pinned: boolean, how: "button" | "preference") => {
    const before = await boardNow();
    const heldBefore = await sourceNow();
    const stays = !pinned && added.has(key); // a section he added is always placed
    let ok: boolean;
    let reason = "";
    if (how === "button") {
      const res = await route({ action: "pin", component: key, pinned });
      ok = res.ok;
      reason = res.json.error ?? "";
    } else {
      const res = (await executeTool(ctx, "set_layout_preference", { kind: "pin_section", section: key, ...(pinned ? {} : { remove: true }) })).result as { error?: string };
      ok = !res.error;
      reason = res.error ?? "";
    }
    if (!ok) return refused(reason || "no reason given", stays ? "a section he added cannot be unpinned" : !pinned && how === "preference" ? "no such preference to remove" : null);
    if (stays) complain("a section he added cannot be unpinned", `unpin ${short(key)} was applied`);
    const what = `${pinned ? "pin" : "unpin"} ${short(key)} (${how})`;
    await afterRequest(what, before, pinned ? before : null, [key], null, pinned ? [...new Set([...placedSet(), key])] : without(placedSet(), key), heldBefore);
  };

  // --- the walk ------------------------------------------------------------------------
  await openTwice("the first open", { firstMayStore: true });
  for (let step = 0; step < STEPS; step++) {
    const full = await boardNow();
    const board = without(full, BANNER);
    const hidden = [...(await hiddenNow())];
    const draw = r.next();
    const count = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const placedOnBoard = told.filter((t) => board.includes(t.key));
    if (!board.length) break;
    if (draw < 0.26) {
      // The voice tool. Biased toward what he placed and its neighbours, from above and from below, so places meet.
      const op = r.pick(["move_to_top", "move_up", "move_up", "move_down", "move_down", "move_to_bottom", "hide", "hide", "show", "show"] as const);
      let key: string;
      if (placedOnBoard.length && r.chance(0.45)) {
        // Aim at a placed section from the far side: the one above it moves down onto it, the one below moves up onto it.
        const at = board.indexOf(r.pick(placedOnBoard).key);
        key = op === "move_down" ? (board[at - 1] ?? board[at]) : op === "move_up" ? (board[at + 1] ?? board[at]) : board[at];
      } else if (op === "show" && hidden.length) key = r.pick(hidden);
      else if (subproject && r.chance(0.04)) key = "subproject";
      else key = r.pick([...board, ...hidden]);
      if (key === "subproject") {
        moves.push(`arrange ${op} the subproject`);
        count("arrange, naming the subproject");
        const res = (await executeTool(ctx, "arrange_dashboard", { operations: [{ op, section: subproject! }] })).result as { applied?: boolean; error?: string };
        if (res.applied) complain("a subproject has no card", `arrange ${op} ${subproject} was applied`);
        else refused(res.error ?? "", "a subproject has no card");
      } else if (r.chance(0.2) && board.length > 2) {
        const second = r.pick(board.filter((k) => k !== key));
        const op2 = r.pick(["move_to_top", "hide", "move_to_bottom", "show"] as const);
        moves.push(`arrange ${op} ${short(key)} + ${op2} ${short(second)}`);
        count("arrange, two operations");
        await arrange(r.chance(0.3) ? [{ op: "hide", key }, { op: "show", key }] : [{ op, key }, { op: op2, key: second }]);
      } else {
        moves.push(`arrange ${op} ${short(key)}`);
        count(`arrange ${op}`);
        await arrange([{ op, key }]);
      }
    } else if (draw < 0.44) {
      const kind = r.pick(["move", "move", "move", "remove", "add back", "add new", "set_props", "two"] as const);
      count(`edit ${kind}`);
      // An index as get_current_plan numbers the plan (the banner, when there is one, is position 0); half the time the one a placed section holds.
      const ontoPlaced = () => (placedOnBoard.length && r.chance(0.5) ? full.indexOf(r.pick(placedOnBoard).key) : r.int(full.length + 3));
      if (kind === "move") {
        const key = r.pick(board);
        const to = ontoPlaced();
        moves.push(`edit move ${short(key)} to ${to}`);
        await edit([{ op: "move", section: key, to }]);
      } else if (kind === "remove") {
        const key = r.pick(board);
        moves.push(`edit remove ${short(key)}`);
        await edit([{ op: "remove", section: key }]);
      } else if (kind === "add back" && hidden.length) {
        const key = r.pick(hidden);
        moves.push(`edit add back ${short(key)}`);
        await edit([isCard(key) ? { op: "add", component: "project_card", props: { project_id: key.slice(13) }, at: r.int(4) } : { op: "add", component: key, at: r.int(4) }]);
      } else if (kind === "add new") {
        const key = r.pick(ADDABLE);
        const at = r.int(board.length + 1);
        moves.push(`edit add new ${key} at ${at}`);
        await edit([{ op: "add", component: key, at }]);
      } else if (kind === "set_props") {
        const cards = board.filter(isCard);
        if (cards.length) {
          const key = r.pick(cards);
          moves.push(`edit set_props ${short(key)} compact`);
          await edit([{ op: "set_props", section: key, props: { variant: "compact" } }]);
        }
      } else if (board.length > 2) {
        const a = r.pick(board);
        const b = r.pick(board.filter((k) => k !== a));
        const to = ontoPlaced();
        const first = r.chance(0.5) ? { op: "move", section: a, to: r.int(full.length) } : { op: "remove", section: a };
        moves.push(`edit ${first.op} ${short(a)} + move ${short(b)} to ${to}`);
        await edit([first, { op: "move", section: b, to }]);
      }
    } else if (draw < 0.53) {
      // The pin button and the preference tool's pin: on or off, on anything on the board.
      const key = r.pick(board);
      const isPinned = (await head()).pinned.includes(key) || (await prefs()).some((p) => p.kind === "pin_section" && p.value.section === key);
      const how = r.chance(0.75) ? ("button" as const) : ("preference" as const);
      moves.push(`${isPinned ? "unpin" : "pin"} ${short(key)} (${how})`);
      count(`${how}: ${isPinned ? "unpin" : "pin"}`);
      await pin(key, !isPinned, how);
    } else if (draw < 0.57) {
      moves.push("put it back");
      count("put it back");
      const n = await versions();
      const res = await route({ action: "revert" });
      if (!res.ok) refused(res.json.error ?? "no reason given", n < 2 ? "nothing to put back" : null);
      else {
        // The walker's own history: what he had placed, and where, one stored version back.
        told = (history[history.length - 2] ?? []).filter((t) => !isCard(t.key) || [...ids.values()].some((pid) => `project_card:${pid}` === t.key)).map((t) => ({ ...t }));
        await remember();
        history[history.length - 1] = told.map((t) => ({ ...t }));
        await openTwice("put it back", { firstMayStore: false });
      }
    } else if (draw < 0.6) {
      const enabled = !(await computeCurrentPlan(id)).signals.context.calm_mode;
      moves.push(`calm mode ${enabled ? "on" : "off"}`);
      count("calm mode");
      await route({ action: "calm_mode", enabled });
      await openTwice("calm mode", { firstMayStore: true });
    } else if (draw < 0.64) {
      // Settings lifts a hide or a ban: a request like the others; the section goes where the system has it.
      const all = (await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, id))).filter((p) => p.kind === "hide_section" || p.kind === "ban_component");
      if (all.length) {
        const pref = r.pick(all);
        const value = pref.value as Record<string, string>;
        const key = value.section ?? value.component;
        const before = await boardNow();
        moves.push(`settings lifts ${pref.kind} ${short(key)}`);
        count("settings lifts a preference");
        await route({ action: "remove_preference", id: pref.id });
        if (pref.kind === "hide_section" && added.has(key)) told = [...told, { key, from: "bottom", n: 0 }]; // back, placed at the end
        const first = await openTwice("settings lifts a preference", { firstMayStore: false });
        const others = (list: string[]) => list.filter((k) => k !== key && !(pref.kind === "ban_component" && k.split(":")[0] === key));
        if (others(first.board).join() !== others(before).join()) complain("everything else kept its order", `settings lifts ${pref.kind}: ${row(others(first.board))} | before ${row(others(before))}`);
        told = readPlaces(first.board, placedSet().filter((k) => first.board.includes(k)));
      }
    } else if (draw < 0.69) {
      const banned = [...(await bannedNow())];
      const remove = banned.length > 0 && r.chance(0.6);
      const component = remove ? r.pick(banned) : r.pick(["people_index", "stat_row", "kanban", "date_chase", "coming_up"]);
      moves.push(`${remove ? "unban" : "ban"} ${component}`);
      count(remove ? "unban" : "ban");
      const heldBefore = await sourceNow();
      const res = (await executeTool(ctx, "set_layout_preference", { kind: "ban_component", component, ...(remove ? { remove: true } : {}) })).result as { error?: string };
      if (res.error) refused(res.error, null);
      else {
        if (!remove) told = told.filter((t) => t.key !== component);
        await openTwice(`${remove ? "unban" : "ban"} ${component}`, { firstMayStore: true });
        if (heldBefore !== "previous" && (await sourceNow()) === "previous") complain("a ban alone does not hold the plan", `${remove ? "unban" : "ban"} ${component}`);
      }
    } else if (draw < 0.73) {
      moves.push("the next day");
      count("the next day");
      await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
      clearPlanCache();
      await openTwice("the next day", { firstMayStore: true });
    } else if (draw < 0.8) {
      // A planner answer lands. Most are a banner; some move the strip; some are answers a planner should not give.
      const kind = r.pick(["a banner", "a banner", "a banner and the strip to the top", "a banner and the strip to the top", "without a default section", "the cards backwards", "a place written on a section", "not a plan at all"] as const);
      moves.push(`a planner answer: ${kind}`);
      count(`a planner answer: ${kind}`);
      const names = [...ids.keys()];
      if (names.length) await db.insert(tasks).values({ userId: id, projectId: ids.get(r.pick(names))!, title: `for the planner ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
      const pinnedBefore = [...(await head()).pinned];
      await open("the planner is asked", { mayStore: true, planner: (signals) => {
        const plan = defaultPlan(signals);
        const banner: PlanSection = { component: BANNER, props: { text: "Several things are late", tone: "serious" } };
        const rest = plan.sections.filter((s) => s.component !== "timeline");
        const strip: PlanSection = { component: "timeline", props: { span_days: 14, expanded: true }, why: "Dates first this week" };
        const answer = (sections: PlanSection[]) => JSON.stringify({ ...plan, plan_id: "p", reason_summary: "A busy week", sections });
        if (kind === "not a plan at all") return "I would put the dates first this week.";
        if (kind === "a banner and the strip to the top") return answer([banner, strip, ...rest]);
        if (kind === "without a default section") return answer([banner, ...plan.sections.filter((s) => s.component !== "people_index")]);
        if (kind === "the cards backwards") return answer([banner, ...plan.sections.filter((s) => s.component !== "project_card").slice(0, 3), ...plan.sections.filter((s) => s.component === "project_card").toReversed(), ...plan.sections.filter((s) => s.component !== "project_card").slice(3)]);
        if (kind === "a place written on a section") return answer([banner, ...plan.sections.map((s) => (s.component === "date_chase" ? { ...s, place: 1 } : s))]);
        return answer([banner, ...plan.sections]);
      } });
      const pinnedAfter = (await head()).pinned;
      if (pinnedAfter.toSorted().join() !== pinnedBefore.toSorted().join()) complain("a planner's answer does not pin anything", `${kind}: ${pinnedBefore.map(short).join(" ")} -> ${pinnedAfter.map(short).join(" ")}`);
      await openTwice("after the planner's answer", { firstMayStore: true });
    } else if (draw < 0.86) {
      // The rules' own moves: he asks about dates all day (the strip goes up, a day after the layout last changed), then stops; or talks about one project.
      const kind = r.pick(["he asks about dates", "the talk stops", "he talks about one project"] as const);
      moves.push(`rules: ${kind}`);
      count(`rules: ${kind}`);
      const names = [...ids.keys()];
      if (kind === "the talk stops") await db.update(messages).set({ createdAt: day(-3) }).where(and(eq(messages.userId, id), like(messages.content, `%${MARK}%`)));
      else {
        const [conv] = await db.insert(conversations).values({ userId: id, mode: "text" }).returning();
        const text = kind === "he asks about dates" ? "when is the deadline?" : `what is next on ${r.pick(names.length ? names : ["nothing"])}`;
        await db.insert(messages).values(Array.from({ length: 6 }, (_, i) => ({ userId: id, conversationId: conv.id, role: "user" as const, content: `${text} ${MARK} (${i})`, mode: "text" as const })));
      }
      await openTwice(`rules: ${kind}`, { firstMayStore: true });
    } else {
      // His data.
      const names = [...ids.keys()];
      const kind = r.pick(["a task", "a task", "every date of a project", "a task finished", "a task deleted", "archive", "back from the archive", "a new project", "a committed deadline"] as const);
      count(`data: ${kind}`);
      if (kind === "a task" && names.length) {
        const name = r.pick(names);
        const due = r.pick([-6, -1, 2, 20, null]);
        moves.push(`data: a task on ${name} due ${due}`);
        await db.insert(tasks).values({ userId: id, projectId: ids.get(name)!, title: `${name}: more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
      } else if (kind === "every date of a project" && names.length) {
        const name = r.pick(names);
        const due = r.pick([-9, 5, 30, null]);
        moves.push(`data: every date of ${name} set to ${due}`);
        await db.update(tasks).set({ dueAt: due === null ? null : day(due) }).where(and(eq(tasks.userId, id), eq(tasks.projectId, ids.get(name)!)));
      } else if ((kind === "a task finished" || kind === "a task deleted") && names.length) {
        const name = r.pick(names);
        const open = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.userId, id), eq(tasks.projectId, ids.get(name)!), eq(tasks.status, "todo")));
        if (open.length) {
          moves.push(`data: ${kind} on ${name}`);
          if (kind === "a task finished") await db.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.id, r.pick(open).id));
          else await db.delete(tasks).where(eq(tasks.id, r.pick(open).id));
        }
      } else if (kind === "archive" && names.filter((n) => n !== "Shopping").length > Math.min(5, Math.max(1, size - 1))) {
        const name = r.pick(names.filter((n) => n !== "Shopping"));
        moves.push(`data: ${name} archived`);
        await db.update(projects).set({ status: "archived" }).where(eq(projects.id, ids.get(name)!));
        archived.set(name, ids.get(name)!);
        ids.delete(name);
      } else if (kind === "back from the archive" && archived.size) {
        const name = r.pick([...archived.keys()]);
        moves.push(`data: ${name} back from the archive`);
        await db.update(projects).set({ status: "active" }).where(eq(projects.id, archived.get(name)!));
        ids.set(name, archived.get(name)!);
        archived.delete(name);
      } else if (kind === "a committed deadline" && names.filter((n) => n !== "Shopping").length) {
        const name = r.pick(names.filter((n) => n !== "Shopping"));
        const due = r.pick([4, 0, -3]);
        moves.push(`data: ${name} has a committed deadline in ${due} days`);
        await db.update(projects).set({ deadline: day(due), deadlineKind: "committed" }).where(eq(projects.id, ids.get(name)!));
      } else {
        const name = NEW_NAMES.find((n) => !ids.has(n) && !archived.has(n));
        if (name) {
          const due = r.pick([null, -4, 4]);
          moves.push(`data: a new project ${name} due ${due}`);
          await addProject(name, due);
        }
      }
      await openTwice("his data changed", { firstMayStore: true });
    }
  }
  return { complaints, moves, counts, refusals, size, storedBoard: await marked() };
}

afterAll(async () => {
  if (users.length) await db.delete(user).where(inArray(user.id, users));
});

describe(`a random walk over the Overview (${WALKS} walks of ${STEPS} steps, seed ${SEED})`, { timeout: 1_200_000 }, () => {
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
        [`WALK ${index} (seed ${SEED}, a board of ${result.size}): ${result.complaints.length} complaint(s)`, ...result.complaints.slice(0, PRINT_ALL ? undefined : 6).map((c) => `  [${c.check}] ${c.detail}`), `  the last six moves: ${result.moves.slice(-6).join(" ; ")}`, `  the stored board (@place, *pinned): ${result.storedBoard}`].join("\n")
      );
    }
    expect(result.complaints.map((c) => c.check)).toEqual([]);
  });

  afterAll(() => {
    console.log(
      ["WALK TALLY", `  complaints by check: ${JSON.stringify(Object.fromEntries([...tally].toSorted()))}`, `  moves reached: ${JSON.stringify(Object.fromEntries([...reached].toSorted()))}`, `  refusals the walker expected, by reason: ${JSON.stringify(Object.fromEntries(refusedFor))}`].join("\n")
    );
  });
});

// The chip under a deadline against the count the date beside it uses
// (lib/due.ts), with the clock moved across midnight and across the due hour:
// a committed deadline ahead, today and past, and a task due at 17:00 (the
// date the system infers, which is where round 3 failed).
describe("the chip under a deadline says what the date beside it says", { timeout: 60_000 }, () => {
  afterEach(() => vi.useRealTimers());
  // In November Los Angeles is eight hours behind UTC: 17:00 there is 01:00 UTC the next day.
  const TIMES = [
    ["the evening before", "2026-11-10T05:54:00Z"],
    ["the next morning", "2026-11-10T17:00:00Z"],
    ["after 17:00 that day", "2026-11-11T01:30:00Z"],
    ["two days on", "2026-11-12T17:00:00Z"],
  ];

  it.each([
    ["a committed deadline ahead", { deadline: "2026-11-14T01:00:00Z" }],
    ["a committed deadline that day", { deadline: "2026-11-11T01:00:00Z" }],
    ["a committed deadline already past", { deadline: "2026-11-08T01:00:00Z" }],
    ["a task due at 17:00 the next day", { task: "2026-11-11T01:00:00Z" }],
    ["a task due at 17:00 in three days", { task: "2026-11-13T01:00:00Z" }],
  ])("%s", async (_what, when: { deadline?: string; task?: string }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(TIMES[0][1]));
    const id = `test-walk-${crypto.randomUUID()}`;
    users.push(id);
    await db.insert(user).values({ id, name: "Chip", email: `${id}@v102.test`, timezone: TZ });
    const [p] = await db.insert(projects).values({ userId: id, name: "Report", status: "active", ...(when.deadline ? { deadline: new Date(when.deadline), deadlineKind: "committed" as const } : {}) }).returning();
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: "Send the report", status: "todo", source: "spoken", dueAt: when.task ? new Date(when.task) : null });
    const date = new Date(when.deadline ?? when.task!);
    const wrong: string[] = [];
    let chips = 0;
    for (const [label, now] of TIMES) {
      vi.setSystemTime(new Date(now));
      for (let open = 0; open < 2; open++) {
        const bundle = await computeCurrentPlan(id);
        await persistPlan(id, bundle);
        const signal = bundle.signals.projects.find((x) => x.id === p.id)!;
        const why = bundle.plan.sections.find((s) => s.props?.project_id === p.id)?.why;
        // Rule 1 fires for a date within three days, or a committed one within a week (SPEC §5).
        const fires = signal.days_left !== null && (signal.days_left <= 3 || (signal.deadline_type === "committed" && signal.days_left <= 7));
        if (!fires) continue;
        const days = daysFromToday(date, TZ, new Date(now));
        const want = days < 0 ? `${-days} ${days === -1 ? "day" : "days"} late` : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`;
        if (!why) wrong.push(`${label}: rule 1 fires and there is no chip (the date beside it is ${days} days away)`);
        else if (!why.includes(want)) wrong.push(`${label}: the chip says "${why}" and the date beside it is ${days} days away ("${want}")`);
        else chips++;
      }
    }
    expect(wrong).toEqual([]);
    if (!when.deadline?.startsWith("2026-11-08")) expect(chips).toBeGreaterThan(0);
  });
});
