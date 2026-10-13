// The gate for the Overview's composition (SPEC §2, v1.02 r5): a seeded random
// walk over everything that can change the board, with the same questions
// asked after every step. Three rounds were offered on examples and failed on
// a state no example had: two sections he placed meeting at one place on a
// board that had since grown shorter. Examples cannot be the gate again.
//
// WHAT THE MODEL ASSUMES ABOUT THE CARDS (since the fix after the first
// offer of r5): after a request everything else keeps the order he saw,
// except that the cards he has not placed stand where the rule puts them on
// the list as it now is: the place with the fewest of the system's sections
// on the wrong side of them, nearest to where they stood. The model works
// that out with its own count after its own list operation
// (cardsWhereTheRulePutsThem); it does not call the product's runPlace or
// share a helper with it. On the usual order nothing moves. On a board the
// system has crossed (the tiles under the cards, Needs a date above them) a
// request that takes away or brings back one of next up, the tiles, Needs a
// date or People can move the cards to the other side of the tiles; the
// summary counts how often the walk stood there.
//
// THE WALKER HAS A MODEL OF ITS OWN. Before a request it opens the board
// itself, applies the request to that list the plain way (up and down swap
// with the neighbour; the top is the first place under the banner; the bottom
// is the end; remove; insert at n) and requires the reply to be that board,
// section for section. What he placed, and where, is read off that EXPECTED
// board, never off what the product stored. For a section of the default
// board that comes back (shown, added back, let go, a hide or a ban lifted)
// the model says where: where today's rules plan would keep it (returnModel,
// with the walker's own reading of which sections are in step with that
// plan: every run tried, not the validator's table). It is put onto the list
// after everything else the request asked for. Only for a CARD that comes back can it say no
// more than "by the data": there it asks that the card is drawn, that
// everything else kept its order, and the standing questions (the cards he
// did not place are one run in data order). It keeps its own history, one entry per stored version, and
// after "Put it back" expects the entry before.
//
// Everything goes through the real paths: both tools and the preference tool
// through the tool executor, an open as compute-then-store, the pin button,
// Put it back, calm mode and the Settings route that lifts a preference
// through their route handler. Their limits, accepted and named here:
// - the planner's answers include the ones that would turn the board over:
//   cards above next up (every card first; main's shape, cards in two runs),
//   cards last of all, and the two crossings a planner may really make
//   (Needs a date raised above next up, the tiles sunk to the bottom, each
//   with props and a reason, or it never lands), each with the cards first,
//   where they were, and last. The composition has to keep the board the
//   right way up whatever a planner writes: check 4 counts, on the board he
//   sees, the system's sections on the wrong side of the cards, and asks
//   that no other place for the run would have fewer;
// - beside the walks there are as many SCRIPTED ones: a few drawn steps (none
//   to six), then one scripted move, each a place a seed of the Reviewer's
//   reached by chance:
//   (27182818) a section of the usual board hidden, a planner's answer the
//   next day, something pinned, the hidden section brought back by a move,
//   then Put it back twice: the composition put a missing section in after
//   the place for the cards had been worked out;
//   (16180339) a planner's answer that leaves the strip under the cards,
//   then Needs a date or People taken off and brought back: it came back
//   above the strip, and the rules plan was refused from then on;
//   (the Reviewer's probe) a rule's move left waiting (a banner new that
//   day, he asks about dates, a day passes and the stored board is served),
//   then a section taken off and brought back: it came back next to the
//   strip the rule was about to move.
//   A section is taken off and brought back each way he can: hidden and
//   shown, in two requests or in one; hidden and added back; hidden and the
//   hide lifted in Settings; pinned and let go; banned and the ban lifted.
//   They are tests of their own ("scripted N"), so the walks themselves
//   ("walk N") draw exactly what they drew before there were any: a seed
//   and a walk named against an earlier tip still name the same walk;
// - the planner's ANSWER is put in through persistPlan's `call` seam (the
//   budget is $0); everything after the answer is the real code. A planner's
//   plan served again from the in-memory cache is not reached by the walk; it
//   is covered by tests/composition-paths.test.ts only;
// - the route handlers run with a faked session;
// - "the next day" is stored versions made two days old; the chip's own test
//   (at the end of this file) moves the clock with a faked Date, because a
//   browser's clock can be moved and the server's cannot;
// - the chip test decides whether rule 1 "fires" from the product's own
//   signals and thresholds, so a rule that wrongly stops firing would not
//   show there (the thresholds are task 1.06's).
//
// A Settings lift, a ban and Put it back are requests like the others (since
// r5 they go through the one function): the walker's model says what board
// he is told, and what he placed is read again from that board. A ban is
// modelled as a hide of the component's section; a lift as a show (a section
// he had put there himself comes back placed, at the end). After Put it back
// the sections he added are the earlier board's, with those a hide or a ban
// of today's keeps off it. Two refusals the model predicts: a request about
// a component he banned, and a size asked for in calm mode.
//
// WHERE THE WALK STANDS. The last five defects were all found on a board in
// one of a few states, so the tally counts them, step by step: a crossing
// (the system's own sections on the wrong side of each other); the strip
// under the cards; something of his at or above next up and the tiles; and,
// request by request, a section of the system's coming or going, on any
// board and on such a board; and Put it back onto a board that lacks a
// section of the usual board. BOARD_BIAS=1 makes the walk stand there more
// often: on a board in none of those states it has a planner cross it or
// put the cards above the strip; it takes sections of the usual board off
// and brings them back; it presses Put it back more, and straight after a
// section came back. Without it the walk draws exactly what it drew before
// the switch was there.
//
// BOARD_WALKS, BOARD_STEPS and BOARD_SEED size the run; BOARD_PRINT=all
// prints every complaint. The suite runs a small one; the long one
// (BOARD_WALKS=120 BOARD_STEPS=30) is run before an offer. A failing walk
// prints its complaints, its last six moves and the stored board, each place
// and pin marked.
process.env.TZ = "UTC";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";

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
import { planFromRules } from "@/lib/layout/plan-from-rules";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import type { Signals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { POST as layoutRoute } from "@/app/api/layout/route";

const TZ = "America/Los_Angeles";
const WALKS = Number(process.env.BOARD_WALKS ?? 8);
const STEPS = Number(process.env.BOARD_STEPS ?? 16);
const SEED = Number(process.env.BOARD_SEED ?? 20261013);
const PRINT_ALL = process.env.BOARD_PRINT === "all";
const BIAS = Boolean(process.env.BOARD_BIAS);
const NAMES = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris"];
const NEW_NAMES = ["Juniper", "Kestrel", "Larch", "Maple", "Nettle", "Oakum", "Pippin", "Quince"];
/** What the voice tool calls each section when it reads the board back (lib/layout/arrange.ts). */
const SAID: Record<string, string> = { focus_banner: "banner", hero_next_up: "next up", stat_row: "stats", timeline: "project progress", date_chase: "needs a date", people_index: "people", kanban: "kanban", coming_up: "coming up", documents: "documents", suggested_zone: "suggestions" };
const DEFAULT_SECTIONS = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const ADDABLE = ["kanban", "coming_up", "documents", "suggested_zone"];
const BANNER = "focus_banner";
/** Planner answers that move one of the system's sections across the cards' side of the board, with the cards in each of three places. */
const CROSSINGS = [
  "needs a date raised, the cards first",
  "needs a date raised, the cards where they were",
  "needs a date raised, the cards last",
  "the tiles sunk, the cards first",
  "the tiles sunk, the cards where they were",
  "the tiles sunk, the cards last",
] as const;
/** The planner answers the walk puts in (some twice, to come up more often). */
const PLANNER_KINDS: string[] = ["a banner", "a banner", "a banner and the strip to the top", "a banner and the strip to the top", "without a default section", "the cards backwards", "a place written on a section", "not a plan at all", "every card first", "the cards in two runs", "the cards last of all", ...CROSSINGS];
/** What each refusal the model predicts has to say: a keyword of its reason, so one refusal cannot pass for another. */
const REFUSAL_SAYS: Record<string, RegExp> = {
  "an urgent card cannot be hidden": /urgent project/,
  "hiding what is already hidden": /There's no /,
  "a section that is not on the board": /There's no /,
  "adding what is already on the board": /already on the dashboard/,
  "a card for something that is not on the board": /has no card on the dashboard|There's no /,
  "a subproject has no card": /has no card on the dashboard|There's no /,
  "a section he added cannot be unpinned": /stays where you put it/,
  "he asked never to be shown it": /never to be shown/,
  "a size is not set in calm mode": /calm mode/,
  "nothing to put back": /Nothing to revert to/,
};
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
/**
 * The walker's own reading of "in step" (SPEC §2): of the keys in `list`, the
 * longest run that stands in the same order in `order`; of two equally long,
 * the one that ends latest in `order`, then the one whose section before
 * that stands latest, and so on. Every run is tried, one by one: nothing here
 * is the product's.
 */
function longestInStep(list: string[], order: string[]): string[] {
  const at = (run: string[]) => run.map((k) => order.indexOf(k)).toSorted((x, y) => y - x);
  const endsLater = (a: string[], b: string[]) => {
    const [x, y] = [at(a), at(b)];
    const i = x.findIndex((n, j) => n !== y[j]);
    return i !== -1 && x[i] > y[i];
  };
  let best: string[] = [];
  for (let mask = 0; mask < 1 << list.length; mask++) {
    const run = list.filter((_, i) => mask & (1 << i));
    if (!run.every((k, i) => i === 0 || order.indexOf(run[i - 1]) < order.indexOf(k))) continue;
    if (run.length > best.length || (run.length === best.length && endsLater(run, best))) best = run;
  }
  return best;
}
/**
 * Where a section of the default board goes when it comes back (shown, added
 * back, let go, a hide or a ban lifted): where today's rules plan would keep
 * it. `order` is today's system order (the rules plan's; the default's in
 * calm mode), which the walker takes from the product: the rules are not
 * what this walk tests. Of the system's sections on the board (not placed,
 * not the banner, not the cards), those in step with that order are the ones
 * the rules plan would not itself move. The section goes directly under the
 * last of them that precedes it in that order; with none, directly above the
 * first that follows it; with nothing of the system's on the board but
 * cards, in front of those; on a board with nothing of the system's at all,
 * first under the banner.
 */
function returnModel(board: string[], key: string, placed: string[], order: string[]): string[] {
  const rest = without(board, key);
  const own = (k: string) => k !== BANNER && !placed.includes(k);
  const kept = longestInStep(rest.filter((k) => own(k) && !isCard(k) && order.includes(k)), order);
  const here = order.indexOf(key);
  const above = order.slice(0, Math.max(0, here)).findLast((k) => kept.includes(k));
  const below = order.slice(here + 1).find((k) => kept.includes(k));
  const firstOwn = rest.findIndex(own);
  const at = above ? rest.indexOf(above) + 1 : below ? rest.indexOf(below) : firstOwn !== -1 ? firstOwn : rest[0] === BANNER ? 1 : 0;
  return insertAt(rest, key, at);
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
const BELONGS_ABOVE = ["hero_next_up", "stat_row"];
const BELONGS_BELOW = ["date_chase", "people_index"];
/** How many of the system's sections are on the wrong side of the cards when the run stands after `at` of them. The walker's own count. */
const wrongSide = (system: string[], at: number) => system.filter((k, i) => (BELONGS_ABOVE.includes(k) && i >= at) || (BELONGS_BELOW.includes(k) && i < at)).length;
/** The fewest there can be on that list, whatever place the run takes. Above zero, the system's order is crossed. */
const fewestWrong = (system: string[]) => Math.min(...Array.from({ length: system.length + 1 }, (_, at) => wrongSide(system, at)));
/**
 * After a request everything else keeps the order he saw, except that the
 * cards stand where the rule puts them on the board as it now is (SPEC §2):
 * the cards he has not placed, as one run, at the place among the system's
 * sections with the fewest on the wrong side; among such places the nearest
 * to where the run stood; the upper one at equal distance. What he placed is
 * then put back at the places read off the board the request asked for.
 * The walker's own code and its own count: nothing here is the product's.
 */
function cardsWhereTheRulePutsThem(board: string[], placed: string[]): string[] {
  const banner = board.includes(BANNER) ? [BANNER] : [];
  const rest = without(board, BANNER).filter((k) => !placed.includes(k));
  const cards = rest.filter(isCard);
  if (!cards.length) return board;
  const system = rest.filter((k) => !isCard(k));
  const stood = rest.findIndex(isCard);
  let best = 0;
  for (let at = 1; at <= system.length; at++) {
    const [now, was] = [wrongSide(system, at), wrongSide(system, best)];
    if (now < was || (now === was && Math.abs(at - stood) < Math.abs(best - stood))) best = at;
  }
  return [...banner, ...placeInto([...system.slice(0, best), ...cards, ...system.slice(best)], readPlaces(board, placed))];
}
const canon = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canon) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)])) : value;
/** A board as whole sections: the component, its props, its why and its place. */
const whole = (plan: LayoutPlan) => plan.sections.map((s) => JSON.stringify(canon([sectionKey(s), s.props ?? {}, s.why ?? null, s.place ?? null])));

type Complaint = { check: string; detail: string };

async function walk(index: number, scripted = false) {
  const r = rng(SEED + index * 7919 + (scripted ? 4337 : 0));
  /** What is scripted draws from a generator of its own. */
  const rs = rng(SEED * 31 + index * 104_729 + 17);
  const steps = scripted ? rs.int(7) : STEPS;
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
  /**
   * A refusal: one the walker predicted, saying what it predicted (a keyword
   * of the reason), or a complaint. A request of several operations may have
   * more than one reason to be refused; the reply gives one of them.
   */
  const refused = (reason: string, expected: string | string[] | null) => {
    const predicted = expected === null ? [] : [expected].flat();
    if (predicted.length) {
      const said = predicted.find((e) => REFUSAL_SAYS[e]?.test(reason)) ?? predicted[0];
      refusals.set(said, (refusals.get(said) ?? 0) + 1);
      if (!REFUSAL_SAYS[said]?.test(reason)) complain("a predicted refusal gives another reason", `${predicted.join(" / ")}: ${blank(reason)}`);
    } else complain("refused, and the walker had no reason to expect it", blank(reason));
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
    // 4. The right way up, in the spec's words: without the banner and what he placed, the cards are one run, and the
    // run stands where the fewest of the system's sections are on the wrong side of it (next up and the tiles belong
    // above the cards, Needs a date and People below; the strip is neither). Counted here on the board he sees.
    const rest = body.filter((k) => !placedKeys.includes(k));
    const cardAt = rest.map((k, i) => (isCard(k) ? i : -1)).filter((i) => i >= 0);
    if (cardAt.length && cardAt.at(-1)! - cardAt[0] + 1 !== cardAt.length) complain("4 the right way up", `${why}: the cards are not one run: ${row(rest)}`);
    if (cardAt.length) {
      const system = rest.filter((k) => !isCard(k));
      const [here, fewest] = [wrongSide(system, cardAt[0]), fewestWrong(system)];
      if (here !== fewest) complain("4 the right way up", `${why}: ${here} of the system's sections are on the wrong side of the cards where ${fewest} would do: ${row(rest)}`);
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
    // And the converse: nothing else is drawn. Every section that is not the banner or a card is one of the default
    // board's or one he added (no rule and no planner in this walk adds a component), so one that Put it back took
    // off, or that he never asked for, cannot stay or turn up.
    for (const key of body) {
      if (!isCard(key) && !DEFAULT_SECTIONS.includes(key) && !added.has(key)) complain("A nothing else is drawn", `${why}: ${key} is on the board`);
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
    const [stood, systemsBefore] = [standsOn(before, placedSet()), systemsOf(before, placedSet())];
    if (expected) {
      // The list as the request leaves it, then the cards where the rule puts them on that list. Counted for the
      // summary: how often a request of his changed the system's list on a crossed board, and how often the cards moved.
      const asked = expected;
      const placedOn = placedNow.filter((k) => asked.includes(k));
      const systemOf = (list: string[], his: string[]) => without(list, BANNER).filter((k) => !isCard(k) && !his.includes(k));
      const [was, now] = [systemOf(before, placedSet()), systemOf(asked, placedOn)];
      expected = cardsWhereTheRulePutsThem(asked, placedOn);
      if (was.toSorted().join() !== now.toSorted().join() && (fewestWrong(was) > 0 || fewestWrong(now) > 0)) {
        counts.set("on a crossed board, a request changed the system's list", (counts.get("on a crossed board, a request changed the system's list") ?? 0) + 1);
        if (expected.join() !== asked.join()) counts.set("on a crossed board, the cards moved with it", (counts.get("on a crossed board, the cards moved with it") ?? 0) + 1);
      }
    }
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
    if (systemsOf(board, placedSet()) !== systemsBefore) {
      count("requests: a section of the system's came or went");
      if (stood.crossing || stood.stripUnder || stood.hisOnTop) count("requests: ... on a board in one of those states");
    }
    history[history.length - 1] = told.map((t) => ({ ...t }));
    // Asked here, before the open below lets a rule's waiting move land: that move resets the layout clock, and the
    // rules plan is then held for the day by the rule's own doing, not by his request. (The ban's check stood after
    // that open until a seed of the Reviewer's, 14142135, had a ban of something already banned blamed for it.)
    if (heldBefore !== "previous" && (await sourceNow()) === "previous") complain(/^(un)?ban /.test(what) ? "a ban alone does not hold the plan" : "his own request does not hold the plan", what);
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
  /** Today's system order, for where a returning default section goes (returnModel). */
  const systemOrder = async () => {
    const signals = (await computeCurrentPlan(id)).signals;
    return keysOf(signals.context.calm_mode ? defaultPlan(signals) : planFromRules(signals));
  };
  const isDefault = (key: string) => DEFAULT_SECTIONS.includes(key);

  /** One or more operations by voice in one request; the last word about a section wins. */
  const arrange = async (ops: { op: string; key: string }[]) => {
    const before = await boardNow();
    const urgent = new Set((await computeCurrentPlan(id)).signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const heldBefore = await sourceNow();
    let model: string[] | null = before;
    let placedNow = placedSet();
    const subject: string[] = [];
    const predicted: string[] = [];
    const banned = await bannedNow();
    const order = await systemOrder();
    /** The default sections this request brings back: put onto the list after everything else it asked for. */
    const returning: string[] = [];
    for (const { op, key } of ops) {
      const onBoard = (model ?? before).includes(key);
      if (op !== "hide" && banned.has(key.split(":")[0])) predicted.push("he asked never to be shown it");
      // A card he hid whose project has since been archived: there is no card to show or to move.
      if (op !== "hide" && isCard(key) && ![...ids.values()].some((pid) => `project_card:${pid}` === key)) predicted.push("a card for something that is not on the board");
      // The last word about a section wins: an urgent card hidden and then shown in the same request is not hidden.
      if (op === "hide" && isCard(key) && urgent.has(key) && ops.findLast((o) => o.key === key)?.op === "hide") predicted.push("an urgent card cannot be hidden");
      if (op === "hide" && !onBoard) predicted.push("hiding what is already hidden");
      subject.push(key);
      const was: string[] | null = model;
      model = model ? arrangeModel(model, op, key) : null;
      if (op === "hide") placedNow = without(placedNow, key);
      else if (op !== "show") placedNow = [...new Set([...placedNow, key])];
      else if (added.has(key)) placedNow = [...new Set([...placedNow, key])]; // a section he added comes back placed
      // A show of something not on the board: one he added, at the end; one of the default board's, where the system has it.
      if (op === "show" && was && !was.includes(key) && added.has(key)) model = [...was, key];
      if (op === "show" && was && !was.includes(key) && isDefault(key)) {
        model = was;
        returning.push(key);
      }
      if (op === "hide" && returning.includes(key)) returning.splice(returning.indexOf(key), 1);
    }
    for (const key of DEFAULT_SECTIONS) if (model && returning.includes(key) && !model.includes(key)) model = returnModel(model, key, placedNow, order);
    const res = (await executeTool(ctx, "arrange_dashboard", { operations: ops.map((o) => ({ op: o.op, section: nameOf(o.key) })) })).result as { applied?: boolean; error?: string; order?: string[] };
    if (!res.applied) return refused(res.error ?? "no reason given", predicted.length ? predicted : null);
    if (predicted.length) complain("a request the model refuses was applied", `${predicted.join(" / ")}: arrange ${ops.map((o) => `${o.op} ${short(o.key)}`).join(" + ")}`);
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
    const banned = await bannedNow();
    const order = await systemOrder();
    const calm = (await computeCurrentPlan(id)).signals.context.calm_mode;
    let model: string[] | null = before;
    let placedNow = placedSet();
    const subject: string[] = [];
    const predicted: string[] = [];
    let sized: { key: string; variant: string } | null = null;
    for (const o of operations) {
      const key = o.op === "add" ? (o.component === "project_card" ? `project_card:${String(o.props?.project_id)}` : o.component!) : o.section!;
      const onBoard = (model ?? before).includes(key);
      subject.push(key);
      if (o.op === "add") {
        if (banned.has(key.split(":")[0])) predicted.push("he asked never to be shown it");
        else if (onBoard) predicted.push("adding what is already on the board");
        else if (isCard(key) && !ids.has(nameOf(key).replace(/ list$/, ""))) predicted.push("a card for something that is not on the board");
        else if (hidden.has(key) && isDefault(key)) model = model ? returnModel(model, key, placedNow, order) : null; // a show: where the system has it
        else if (hidden.has(key) && !added.has(key)) model = null; // a card shown again: by the data
        else {
          model = model ? editModel(model, o, key) : null; // a new component, or one he added and hid: placed
          placedNow = [...new Set([...placedNow, key])];
          added.add(key);
        }
        continue;
      }
      if (!onBoard) {
        predicted.push("a section that is not on the board");
        continue;
      }
      if (o.op === "remove") {
        if (isCard(key) && urgent.has(key)) predicted.push("an urgent card cannot be hidden");
        placedNow = without(placedNow, key);
      }
      if (o.op === "move") placedNow = [...new Set([...placedNow, key])];
      // Calm mode shows every section the plain way: a size cannot show there, and the honest answer is no.
      if (o.op === "set_props" && calm) predicted.push("a size is not set in calm mode");
      if (o.op === "set_props") sized = { key, variant: String(o.props?.variant) };
      model = model ? editModel(model, o, key) : null;
    }
    const res = (await executeTool(ctx, "edit_layout_plan", { operations })).result as { applied?: boolean; error?: string; sections?: string[]; size_note?: string };
    if (!res.applied) return refused(res.error ?? "no reason given", predicted.length ? predicted : null);
    if (predicted.length) complain("a request the model refuses was applied", `${predicted.join(" / ")}: ${operations.map((o) => o.op).join("+")}`);
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
    if (!ok) return refused(reason || "no reason given", stays ? "a section he added cannot be unpinned" : null);
    if (stays) complain("a request the model refuses was applied", `a section he added cannot be unpinned: unpin ${short(key)}`);
    const what = `${pinned ? "pin" : "unpin"} ${short(key)} (${how})`;
    const placedNow = pinned ? [...new Set([...placedSet(), key])] : without(placedSet(), key);
    // Pinned, the board is the same. Let go, a default section goes where the system has it; a card, by the data.
    const expected = pinned ? before : isDefault(key) ? returnModel(before, key, placedNow, await systemOrder()) : null;
    await afterRequest(what, before, expected, [key], null, placedNow, heldBefore);
  };

  const count = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const nextDay = async () => {
    moves.push("the next day");
    count("the next day");
    await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
    clearPlanCache();
    await openTwice("the next day", { firstMayStore: true });
  };
  /** Put it back, with what the walker's own history says he must then see. */
  const putItBack = async () => {
    moves.push("put it back");
    count("put it back");
    const n = await versions();
    const [, earlier] = await db.select({ spec: layoutSpecs.spec }).from(layoutSpecs).where(eq(layoutSpecs.userId, id)).orderBy(desc(layoutSpecs.version)).limit(2);
    const res = await route({ action: "revert" });
    if (!res.ok) refused(res.json.error ?? "no reason given", n < 2 ? "nothing to put back" : null);
    else {
      const [was, hiddenToday0, bannedToday0] = [keysOf(earlier.spec as LayoutPlan), await hiddenNow(), await bannedNow()];
      if (DEFAULT_SECTIONS.some((k) => !was.includes(k) && !hiddenToday0.has(k) && !bannedToday0.has(k))) count("put it back onto a board that lacks a section of the usual board");
      // The walker's own history: what he had placed, and where, one stored version back.
      told = (history[history.length - 2] ?? []).filter((t) => !isCard(t.key) || [...ids.values()].some((pid) => `project_card:${pid}` === t.key)).map((t) => ({ ...t }));
      // A section he added goes back with the board: one the earlier board did not have is no longer on it, unless it
      // is off the board by a hide or a ban of today's (those live outside the versions, and bring it back when lifted).
      const [hiddenToday, bannedToday] = [await hiddenNow(), await bannedNow()];
      for (const key of [...added]) if (!told.some((t) => t.key === key) && !hiddenToday.has(key) && !bannedToday.has(key)) added.delete(key);
      // And the other way: a section the earlier board had because he added it is his again (Put it back twice is a redo).
      for (const t of told) if (!isCard(t.key) && !DEFAULT_SECTIONS.includes(t.key)) added.add(t.key);
      await remember();
      const first = await openTwice("put it back", { firstMayStore: false });
      // Put it back is a request: after it, what he placed is read again from the board he was told.
      told = readPlaces(first.board, placedSet().filter((k) => first.board.includes(k)));
      history[history.length - 1] = told.map((t) => ({ ...t }));
    }
  };
  const plannerAnswers = async (kind: string) => {
    // A planner answer lands. Most are a banner; some move the strip; some are answers a planner should not give.
    moves.push(`a planner answer: ${kind}`);
    count(`a planner answer: ${kind}`);
    const names = [...ids.keys()];
    if (names.length) await db.insert(tasks).values({ userId: id, projectId: ids.get(r.pick(names))!, title: `for the planner ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
    const pinnedBefore = [...(await head()).pinned];
    const stands = keysOf((await head()).spec as LayoutPlan);
    await open("the planner is asked", { mayStore: true, planner: (signals) => {
      const plan = defaultPlan(signals);
      const banner: PlanSection = { component: BANNER, props: { text: "Several things are late", tone: "serious" } };
      const rest = plan.sections.filter((s) => s.component !== "timeline");
      const strip: PlanSection = { component: "timeline", props: { span_days: 14, expanded: true }, why: "Dates first this week" };
      const answer = (sections: PlanSection[]) => JSON.stringify({ ...plan, plan_id: "p", reason_summary: "A busy week", sections });
      if (kind === "not a plan at all") return "I would put the dates first this week.";
      // What the planner on main writes, and what nothing stops one from writing: cards above next up. Every card
      // before it; or main's shape, two cards on top and the rest under the strip.
      const cards = plan.sections.filter((s) => s.component === "project_card");
      const others = plan.sections.filter((s) => s.component !== "project_card");
      if (kind === "every card first") return answer([banner, ...cards, ...others]);
      // (Scripted only.) Every card first and the other sections in the order the board has them: nothing of the
      // system's moves, so it lands on a board whatever its order, and the composition leaves the strip under the cards.
      const where = (x: PlanSection) => (stands.includes(sectionKey(x)) ? stands.indexOf(sectionKey(x)) : plan.sections.indexOf(x) - 0.5);
      if (kind === "every card first, the rest as it stands") return answer([banner, ...cards, ...others.toSorted((x, y) => where(x) - where(y))]);
      if (kind === "the cards in two runs") return answer([banner, ...cards.slice(0, 2), ...others.slice(0, 3), ...cards.slice(2), ...others.slice(3)]);
      if (kind === "the cards last of all") return answer([banner, ...others, ...cards]);
      // A planner may move one of the system's sections, with a reason, a day after the layout last changed. Props
      // go with it: a reason on a section left exactly as the default has it is stripped, and the move then refused.
      // Both crossings (Needs a date raised above next up; the tiles sunk to the bottom), each with the cards
      // first, where they were, and last.
      if ((CROSSINGS as readonly string[]).includes(kind)) {
        const raised = kind.startsWith("needs a date raised");
        const moved: PlanSection = raised
          ? { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" }
          : { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };
        const kept = plan.sections.filter((s) => s.component !== moved.component);
        const crossed = raised ? [moved, ...kept] : [...kept, moved];
        const noCards = crossed.filter((s) => s.component !== "project_card");
        if (kind.endsWith("the cards first")) return answer([banner, ...cards, ...noCards]);
        if (kind.endsWith("the cards last")) return answer([banner, ...noCards, ...cards]);
        return answer([banner, ...crossed]);
      }
      if (kind === "a banner and the strip to the top") return answer([banner, strip, ...rest]);
      if (kind === "without a default section") return answer([banner, ...plan.sections.filter((s) => s.component !== "people_index")]);
      if (kind === "the cards backwards") return answer([banner, ...plan.sections.filter((s) => s.component !== "project_card").slice(0, 3), ...plan.sections.filter((s) => s.component === "project_card").toReversed(), ...plan.sections.filter((s) => s.component !== "project_card").slice(3)]);
      if (kind === "a place written on a section") return answer([banner, ...plan.sections.map((s) => (s.component === "date_chase" ? { ...s, place: 1 } : s))]);
      return answer([banner, ...plan.sections]);
    } });
    const pinnedAfter = (await head()).pinned;
    if (pinnedAfter.toSorted().join() !== pinnedBefore.toSorted().join()) complain("a planner's answer does not pin anything", `${kind}: ${pinnedBefore.map(short).join(" ")} -> ${pinnedAfter.map(short).join(" ")}`);
    await openTwice("after the planner's answer", { firstMayStore: true });
  };

  /** Settings lifts a hide or a ban: a request like the others. A section he had put on the board himself comes
   *  back placed, at the end; anything else goes where the system has it; under a ban or a hide still standing, nothing comes. */
  const lift = async (pref: { id: string; kind: string; value: unknown }) => {
    const value = pref.value as Record<string, string>;
    const key = value.section ?? value.component;
    const before = await boardNow();
    const heldBefore = await sourceNow();
    const stillOff = pref.kind === "hide_section" ? (await bannedNow()).has(key.split(":")[0]) : (await hiddenNow()).has(key);
    moves.push(`settings lifts ${pref.kind} ${short(key)}`);
    count("settings lifts a preference");
    const res = await route({ action: "remove_preference", id: pref.id });
    if (!res.ok) return refused(res.json.error ?? "no reason given", null);
    const his = added.has(key) && !stillOff;
    const expected = stillOff || before.includes(key) ? before : his ? [...before, key] : isDefault(key) ? returnModel(before, key, placedSet(), await systemOrder()) : null;
    await afterRequest(`settings lifts ${pref.kind} ${short(key)}`, before, expected, [key], null, his ? [...new Set([...placedSet(), key])] : placedSet(), heldBefore);
  };
  /** The preference tool bans a component, or takes a ban back. */
  const ban = async (component: string, remove: boolean) => {
    moves.push(`${remove ? "unban" : "ban"} ${component}`);
    count(remove ? "unban" : "ban");
    const before = await boardNow();
    const heldBefore = await sourceNow();
    const stillHidden = (await hiddenNow()).has(component);
    const res = (await executeTool(ctx, "set_layout_preference", { kind: "ban_component", component, ...(remove ? { remove: true } : {}) })).result as { error?: string };
    if (res.error) return refused(res.error, null);
    // A ban is a hide of the component's section: the board he saw without it, everything else in order, its place
    // gone. Lifted, a section he had put there himself comes back placed, at the end; another goes where the system has it.
    const his = remove && added.has(component) && !stillHidden;
    const expected = remove ? (stillHidden ? before : his ? [...before, component] : isDefault(component) ? returnModel(before, component, placedSet(), await systemOrder()) : null) : without(before, component);
    const placedNow = remove ? (his ? [...new Set([...placedSet(), component])] : placedSet()) : without(placedSet(), component);
    await afterRequest(`${remove ? "unban" : "ban"} ${component}`, before, expected, [component], null, placedNow, heldBefore);
  };
  /** He says the same thing six times today (the rules read what he talks about). */
  const says = async (text: string) => {
    const [conv] = await db.insert(conversations).values({ userId: id, mode: "text" }).returning();
    await db.insert(messages).values(Array.from({ length: 6 }, (_, i) => ({ userId: id, conversationId: conv.id, role: "user" as const, content: `${text} ${MARK} (${i})`, mode: "text" as const })));
  };
  /** A section of the usual board taken off and brought back, one of the ways he can. */
  const WAYS = ["hidden, shown", "hidden and shown in one request", "hidden, added back", "hidden, the hide lifted in Settings", "pinned, let go", "banned, the ban lifted"] as const;
  const hidesOf = async (key: string) => (await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, id))).filter((p) => p.kind === "hide_section" && (p.value as Record<string, string>).section === key);
  const offAndBack = async (key: string, way: (typeof WAYS)[number]) => {
    if (way === "hidden and shown in one request") return arrange([{ op: "hide", key }, { op: "show", key }]);
    if (way === "pinned, let go") {
      await pin(key, true, "button");
      return pin(key, false, "button");
    }
    if (way === "banned, the ban lifted") {
      await ban(key, false);
      return ban(key, true);
    }
    await arrange([{ op: "hide", key }]);
    if (way === "hidden, shown") return arrange([{ op: "show", key }]);
    if (way === "hidden, added back") return edit([{ op: "add", component: key, at: rs.int(4) }]);
    for (const pref of await hidesOf(key)) await lift(pref);
  };
  /** What stands on the board he sees: the strip under the cards; a rule's move of the strip still to come. */
  const stripUnderTheCards = async () => {
    const body = without(await boardNow(), BANNER).filter((k) => !placedSet().includes(k));
    return body.includes("timeline") && body.some(isCard) && body.indexOf("timeline") > body.findLastIndex(isCard);
  };
  const stripIsWaiting = async () => {
    const [order, board] = [(await systemOrder()).filter((k) => !isCard(k) && k !== BANNER), without(await boardNow(), BANNER).filter((k) => !isCard(k) && !placedSet().includes(k))];
    return order[0] === "timeline" && board.includes("timeline") && board[0] !== "timeline" && (await sourceNow()) === "rules";
  };
  /** Where a board stands: the states the last five defects were found in. */
  const standsOn = (list: string[], his: string[]) => {
    const body = without(list, BANNER);
    const rest = body.filter((k) => !his.includes(k));
    return {
      crossing: fewestWrong(rest.filter((k) => !isCard(k))) > 0,
      stripUnder: rest.includes("timeline") && rest.some(isCard) && rest.indexOf("timeline") > rest.findLastIndex(isCard),
      hisOnTop: body.slice(0, Math.max(body.indexOf("hero_next_up"), body.indexOf("stat_row")) + 1).some((k) => his.includes(k)),
    };
  };
  const systemsOf = (list: string[], his: string[]) => without(list, BANNER).filter((k) => !isCard(k) && !his.includes(k)).toSorted().join();
  // --- the walk ------------------------------------------------------------------------
  await openTwice("the first open", { firstMayStore: true });
  for (let step = 0; step < steps; step++) {
    const full = await boardNow();
    const board = without(full, BANNER);
    const hidden = [...(await hiddenNow())];
    const stands = standsOn(full, placedSet());
    count("steps");
    if (stands.crossing) count("stands: on a crossing");
    if (stands.stripUnder) count("stands: with the strip under the cards");
    if (stands.hisOnTop) count("stands: with something of his at or above next up and the tiles");
    if (["hero_next_up", "stat_row"].some((k) => full.includes(k) && placedSet().includes(k))) count("stands: with next up or the tiles his");
    if (BIAS && board.length) {
      const b = r.next();
      if (!stands.crossing && !stands.stripUnder && b < 0.3) {
        // Onto such a board: a day on (a planner may move a section a day after the layout last changed), a planner's
        // answer that crosses the board or leaves the strip under the cards.
        moves.push("biased: onto a crossed board, or the strip under the cards");
        await nextDay();
        await plannerAnswers(r.pick([...CROSSINGS, "every card first, the rest as it stands", "every card first, the rest as it stands", "every card first, the rest as it stands"]));
        continue;
      }
      if (b < 0.62) {
        // A section of the usual board comes or goes, one of the ways he can.
        const off = DEFAULT_SECTIONS.filter((k) => !full.includes(k));
        const key = off.length && r.chance(0.5) ? r.pick(off) : r.pick(DEFAULT_SECTIONS);
        const banned = (await bannedNow()).has(key);
        const isHis = placedSet().includes(key);
        const what = !full.includes(key) ? (banned ? "the ban lifted" : r.pick(["shown", "added back", "the hide lifted in Settings", "moved onto the board"])) : r.pick(["off and back", "off and back", "hidden", isHis ? "let go" : "pinned", "moved", "banned"]);
        moves.push(`biased: ${key} ${what}`);
        count("biased: a section of the usual board comes or goes");
        if (what === "the ban lifted") await ban(key, true);
        else if (what === "shown") await arrange([{ op: "show", key }]);
        else if (what === "added back") await edit([{ op: "add", component: key, at: r.int(4) }]);
        else if (what === "the hide lifted in Settings") for (const pref of await hidesOf(key)) await lift(pref);
        else if (what === "moved onto the board" || what === "moved") await arrange([{ op: r.pick(["move_up", "move_down", "move_to_top", "move_to_bottom"] as const), key }]);
        else if (what === "off and back") await offAndBack(key, r.pick(WAYS));
        else if (what === "hidden") await arrange([{ op: "hide", key }]);
        else if (what === "banned") await ban(key, false);
        else await pin(key, !isHis, "button");
        // Straight after a section came back, Put it back goes onto a board that lacks it.
        if (["the ban lifted", "shown", "added back", "the hide lifted in Settings", "moved onto the board", "off and back"].includes(what) && r.chance(0.35)) {
          await putItBack();
          if (r.chance(0.5)) await putItBack();
        }
        continue;
      }
      if (b < 0.7) {
        await putItBack();
        continue;
      }
    }
    const draw = r.next();
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
        const sent = r.chance(0.3) ? [{ op: "hide", key }, { op: "show", key }] : [{ op, key }, { op: op2, key: second }];
        moves.push(`arrange ${sent.map((o) => `${o.op} ${short(o.key)}`).join(" + ")}`); // what is sent, not what was first drawn
        count("arrange, two operations");
        await arrange(sent);
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
      await putItBack();
    } else if (draw < 0.6) {
      const enabled = !(await computeCurrentPlan(id)).signals.context.calm_mode;
      moves.push(`calm mode ${enabled ? "on" : "off"}`);
      count("calm mode");
      await route({ action: "calm_mode", enabled });
      await openTwice("calm mode", { firstMayStore: true });
    } else if (draw < 0.64) {
      const all = (await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, id))).filter((p) => p.kind === "hide_section" || p.kind === "ban_component");
      if (all.length) await lift(r.pick(all));
    } else if (draw < 0.69) {
      const banned = [...(await bannedNow())];
      const remove = banned.length > 0 && r.chance(0.6);
      const component = remove ? r.pick(banned) : r.pick(["people_index", "stat_row", "kanban", "date_chase", "coming_up"]);
      await ban(component, remove);
    } else if (draw < 0.73) {
      await nextDay();
    } else if (draw < 0.8) {
      await plannerAnswers(r.pick(PLANNER_KINDS));
    } else if (draw < 0.86) {
      // The rules' own moves: he asks about dates all day (the strip goes up, a day after the layout last changed), then stops; or talks about one project.
      const kind = r.pick(["he asks about dates", "the talk stops", "he talks about one project"] as const);
      moves.push(`rules: ${kind}`);
      count(`rules: ${kind}`);
      const names = [...ids.keys()];
      if (kind === "the talk stops") await db.update(messages).set({ createdAt: day(-3) }).where(and(eq(messages.userId, id), like(messages.content, `%${MARK}%`)));
      else await says(kind === "he asks about dates" ? "when is the deadline?" : `what is next on ${r.pick(names.length ? names : ["nothing"])}`);
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
        // A place goes with its section: his card's place is gone for good with the first board worked out without
        // it (the opens just below). Back from the archive, the card follows the data.
        told = told.filter((t) => t.key !== `project_card:${ids.get(name)!}`);
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
  // --- a scripted walk: after its few steps, one scripted move ----------------------------
  // (Three of them, below; one is drawn for each scripted walk.)
  // Walked into on purpose, after the Reviewer's seed 27182818 found it by chance: a section of the usual board
  // hidden, a planner's answer the next day, something pinned, the hidden section brought back by a move, then
  // Put it back, twice. The earlier board lacks the section (it was hidden then); today it is not hidden, so
  // the composition has to put it in itself, and the board it stores still has to compose to itself.
  // Half the time one of the shapes the Reviewer's grid found wrong on 472c2a7 (all with Needs a date raised
  // above next up: People hidden and next up or the tiles his; the tiles hidden, the plan's cards first, and
  // nothing of next up or the tiles his); half the time any section, any answer, anything pinned.
  const backOntoABoardWithoutIt = async () => {
    const shapes: { gone: string; kind: string; his: string | null }[] = [
      ...CROSSINGS.slice(0, 3).flatMap((kind) => ["hero_next_up", "stat_row"].map((his) => ({ gone: "people_index", kind, his }))),
      ...[null, "timeline", "people_index"].map((his) => ({ gone: "stat_row", kind: CROSSINGS[0], his })),
    ];
    const usual = DEFAULT_SECTIONS.filter((k) => onBoard.includes(k));
    const shape = rs.chance(0.5) ? rs.pick(shapes) : null;
    if (!usual.length || (shape && !usual.includes(shape.gone))) return;
    const gone = shape?.gone ?? rs.pick(usual);
    const kind = shape?.kind ?? rs.pick(PLANNER_KINDS);
    const his = shape ? shape.his : rs.pick([null, ...DEFAULT_SECTIONS.filter((k) => k !== gone)]);
    const op = rs.pick(["move_up", "move_down", "move_to_top", "move_to_bottom"] as const);
    moves.push(`scripted: hide ${gone}; the next day; ${kind}; pin ${his ?? "nothing"}; ${op} ${gone}; put it back twice`);
    count("scripted: a hidden section brought back, then Put it back twice");
    await arrange([{ op: "hide", key: gone }]);
    await nextDay();
    await plannerAnswers(kind);
    if (his && (await boardNow()).includes(his) && !placedSet().includes(his)) await pin(his, true, "button");
    if ((await hiddenNow()).has(gone)) await arrange([{ op, key: gone }]);
    await putItBack();
    await putItBack();
  };
  // The Reviewer's seed 16180339 (walk 61): the strip under the cards on the board he sees (a planner's answer with
  // every card first), and Needs a date or People taken off and brought back. On 472c2a7 it came back under the last
  // card, above the strip, and the rules plan (the strip above both) was refused from then on.
  const backUnderTheStrip = async () => {
    const keys = rs.pick([["date_chase", "people_index"], ["people_index", "date_chase"], ["date_chase"], ["people_index"]]);
    const ways = keys.map(() => rs.pick(WAYS));
    moves.push(`scripted: every card first; ${keys.map((k, i) => `${k} ${ways[i]}`).join("; ")}`);
    count("scripted: the strip under the cards, and a section of the bottom comes back");
    await plannerAnswers("every card first, the rest as it stands");
    for (const [i, key] of keys.entries()) {
      if (!(await boardNow()).includes(key)) continue;
      if (await stripUnderTheCards()) count("scripted: ... and the strip did stand under the cards");
      await offAndBack(key, ways[i]);
    }
  };
  // The Reviewer's probe: a rule's move left waiting. A banner lands; the same day he asks about dates, and the
  // strip's move up is held (the banner is new today); a day later nothing in his data has changed, the stored
  // board is served, and the move is still to come. A section taken off and brought back then has to go where the
  // rules plan will keep it once the strip has moved: not next to the strip. On 472c2a7 next up came back under
  // the strip, and the rules plan was refused from then on.
  const besideAWaitingMove = async () => {
    const key = rs.pick(["hero_next_up", "hero_next_up", "stat_row", "date_chase", "people_index"]);
    const way = rs.pick(WAYS);
    moves.push(`scripted: the next day; a banner; he asks about dates; the next day; ${key} ${way}`);
    count("scripted: a rule's move is waiting, and a section comes back");
    await nextDay();
    await plannerAnswers("a banner");
    await says("when is the deadline?");
    await openTwice("rules: he asks about dates", { firstMayStore: true });
    await nextDay();
    if (!(await boardNow()).includes(key)) return;
    if (await stripIsWaiting()) count("scripted: ... and the strip's move was waiting");
    await offAndBack(key, way);
  };
  const onBoard = without(await boardNow(), BANNER);
  if (scripted && onBoard.length) {
    if ((await computeCurrentPlan(id)).signals.context.calm_mode) {
      // (Out of calm mode first: there the board is the default's and no rule or planner is asked.)
      moves.push("calm mode off");
      await route({ action: "calm_mode", enabled: false });
      await openTwice("calm mode", { firstMayStore: true });
    }
    await rs.pick([backOntoABoardWithoutIt, backUnderTheStrip, besideAWaitingMove])();
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

  const run = async (index: number, scripted: boolean) => {
    clearPlanCache();
    const result = await walk(index, scripted);
    for (const c of result.complaints) tally.set(c.check, (tally.get(c.check) ?? 0) + 1);
    for (const [k, n] of result.counts) reached.set(k, (reached.get(k) ?? 0) + n);
    for (const [k, n] of result.refusals) refusedFor.set(k, (refusedFor.get(k) ?? 0) + n);
    if (result.complaints.length) {
      console.log(
        [`${scripted ? "SCRIPTED" : "WALK"} ${index} (seed ${SEED}, a board of ${result.size}): ${result.complaints.length} complaint(s)`, ...result.complaints.slice(0, PRINT_ALL ? undefined : 6).map((c) => `  [${c.check}] ${c.detail}`), `  the last six moves: ${result.moves.slice(-6).join(" ; ")}`, `  the stored board (@place, *pinned): ${result.storedBoard}`].join("\n")
      );
    }
    expect(result.complaints.map((c) => c.check)).toEqual([]);
  };
  it.each(Array.from({ length: WALKS }, (_, i) => i))("walk %i", (index) => run(index, false));
  it.each(Array.from({ length: WALKS }, (_, i) => i))("scripted %i", (index) => run(index, true));

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
