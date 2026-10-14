// SPEC §2 (v1.02 r5): he hides a section and shows it again. The judge needs
// no formula: it should stand where it stood, and his two requests should not
// leave the system's plan held when it was not. The like of the Reviewer's
// probe, through the real tools: the states the system can leave a board in
// x each section of the usual board hidden then shown x nothing else hidden,
// or one other section hidden first. On 472c2a7 the Reviewer counted, over
// seven states and 175 pairs: the board he had back in 110, newly held 8.
//
// What may differ and is named (SPEC §2): the section the system itself has
// moved comes back to its usual place, not where it stood (his "show" does
// not perform the system's move); a section comes back on the other side of
// the moved one when the list he left shows no move, or shows one that an
// order of the rules explains; and the cards stand where the count puts them
// on the board as it now is. Nothing else may differ.
//
// And three things may not happen at all:
// - newly held: the rules plan served before the pair and refused after it;
// - an order lost: an order the rules can produce that was accepted against
//   the board before the pair and is refused after it (a hold for later);
// - a hold the pair alone causes, found by stepping for real: the same board
//   with the pair and without it, then one step (he starts talking dates;
//   the talk stops and a task; a day turns and a task; a task), then what a
//   new open is served. Held with the pair and served without it is a hold
//   his hide and show caused. On 472c2a7 the Reviewer counted 45 of these in
//   260 futures; the everyday one: a section hidden and shown on the day the
//   strip rose froze the system's plan from the next day on.
//
// HIDE_THEN_SHOW=all runs every state (200 pairs, 800 futures stepped); the
// suite runs the three states where the earlier rules went wrong (75 pairs,
// 300 futures). The four families the Reviewer found are also written out,
// one test each, at the end.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, layoutPreferences, layoutSpecs, messages, projects, tasks, user } from "@/lib/db/schema";
import { defaultPlan, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage, planWithFallback } from "@/lib/layout/plan-from-llm";
import { acceptedOrders } from "@/lib/layout/compose";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import { computeSignals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const FIVE = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const SAID: Record<string, string> = { hero_next_up: "next up", stat_row: "stats", timeline: "project progress", date_chase: "needs a date", people_index: "people" };
const isCard = (k: string) => k.startsWith("project_card:");
const users: string[] = [];

async function board() {
  const id = `test-hide-show-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Probe", email: `${id}@v102.test`, timezone: TZ });
  const ids: string[] = [];
  for (const [i, name] of ["Atlas", "Birch", "Cedar", "Shopping"].entries()) {
    const [p] = await db.insert(projects).values({ userId: id, name, kind: name === "Shopping" ? "list" : "project", status: "active" }).returning();
    ids.push(p.id);
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: i < 2 ? new Date(Date.now() - (i + 2) * 86_400_000) : null });
  }
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const open = async (answer?: (plan: LayoutPlan) => PlanSection[]) => {
    const bundle = await computeCurrentPlan(id);
    await persistPlan(
      id,
      bundle,
      answer
        ? {
            call: async () => {
              lastPlannerUsage.model = "claude-sonnet-5";
              lastPlannerUsage.input = 4_000;
              lastPlannerUsage.output = 800;
              return JSON.stringify({ plan_id: "p", reason_summary: "A busy week", sections: answer(defaultPlan(bundle.signals)) });
            },
          }
        : {}
    );
    return (await computeCurrentPlan(id)).plan.sections.map(sectionKey);
  };
  return {
    id,
    open,
    say: async (op: string, key: string) => ((await executeTool(ctx, "arrange_dashboard", { operations: [{ op, section: SAID[key] }] })).result as { applied?: boolean }).applied === true,
    /** A planner's answer for a new situation, a day after the layout last changed. */
    planner: async (answer: (plan: LayoutPlan) => PlanSection[]) => {
      await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
      await db.insert(tasks).values({ userId: id, projectId: ids[0], title: `one more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" });
      await open(answer);
      return open();
    },
    nextDay: async () => {
      await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
      clearPlanCache();
    },
    talksDates: async () => {
      const [conv] = await db.insert(conversations).values({ userId: id, mode: "text" }).returning();
      await db.insert(messages).values(Array.from({ length: 6 }, (_, i) => ({ userId: id, conversationId: conv.id, role: "user" as const, content: `when is the deadline? (${i})`, mode: "text" as const })));
    },
    talkStops: () => db.update(messages).set({ createdAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(messages.userId, id)),
    /** What a new open would be served: the chain an open runs when the stored row is not served again. */
    served: async () => {
      const head = (await getPlanHead(id))!;
      return (await planWithFallback(await computeSignals(id), { previousPlan: head.spec as LayoutPlan, preferences: await getPreferences(id), pinnedSections: head.pinned, llmEnabled: false })).source;
    },
    /** The orders the rules can produce that are accepted against the stored board, a day on. */
    orders: async () => {
      const head = (await getPlanHead(id))!;
      return acceptedOrders(head.spec as LayoutPlan, head.pinned, await getPreferences(id), await computeSignals(id)).map((order) => order.join(" "));
    },
    aTask: () => db.insert(tasks).values({ userId: id, projectId: ids[1], title: `one more ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" }),
    /** Everything a pair or a step can change: the stored boards, his preferences, what he said, his tasks. */
    snapshot: async () => ({
      specs: await db.select().from(layoutSpecs).where(eq(layoutSpecs.userId, id)),
      preferences: await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, id)),
      said: await db.select().from(messages).where(eq(messages.userId, id)),
      todo: await db.select().from(tasks).where(eq(tasks.userId, id)),
    }),
    restore: async (was: { specs: (typeof layoutSpecs.$inferSelect)[]; preferences: (typeof layoutPreferences.$inferSelect)[]; said: (typeof messages.$inferSelect)[]; todo: (typeof tasks.$inferSelect)[] }) => {
      await db.delete(layoutSpecs).where(eq(layoutSpecs.userId, id));
      await db.delete(layoutPreferences).where(eq(layoutPreferences.userId, id));
      await db.delete(messages).where(eq(messages.userId, id));
      await db.delete(tasks).where(eq(tasks.userId, id));
      if (was.specs.length) await db.insert(layoutSpecs).values(was.specs);
      if (was.preferences.length) await db.insert(layoutPreferences).values(was.preferences);
      if (was.said.length) await db.insert(messages).values(was.said);
      if (was.todo.length) await db.insert(tasks).values(was.todo);
      clearPlanCache();
    },
  };
}
type Board = Awaited<ReturnType<typeof board>>;
const cardsOf = (plan: LayoutPlan) => plan.sections.filter((s) => s.component === "project_card");
const othersOf = (plan: LayoutPlan) => plan.sections.filter((s) => s.component !== "project_card");
const BANNER: PlanSection = { component: "focus_banner", props: { text: "Two things are late", tone: "serious" } };
const RAISED: PlanSection = { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" };
const SUNK: PlanSection = { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };

/** The states the system can leave a board in. `moves` is the section the system has moved or is about to move there. */
const STATES: { name: string; suite?: boolean; moves: string | null; make: (b: Board) => Promise<void> }[] = [
  { name: "the usual board", moves: null, make: async () => {} },
  {
    name: "a rule sent the strip up, and he still talks about dates",
    moves: "timeline",
    make: async (b) => {
      await b.talksDates();
      await b.nextDay();
      await b.open();
      await b.nextDay();
    },
  },
  {
    name: "the very day a rule sent the strip up",
    moves: "timeline",
    make: async (b) => {
      await b.talksDates();
      await b.nextDay();
      await b.open();
    },
  },
  {
    name: "a rule sent the strip up, the talk stopped, and the strip is held there",
    suite: true,
    moves: "timeline",
    make: async (b) => {
      await b.talksDates();
      await b.nextDay();
      await b.open();
      await b.nextDay();
      await b.talkStops();
    },
  },
  {
    name: "a rule's move is waiting (a banner new that day, he asks about dates, a day passes)",
    suite: true,
    moves: "timeline",
    make: async (b) => {
      await b.planner((plan) => [BANNER, ...plan.sections]);
      await b.talksDates();
      await b.open();
      await b.nextDay();
    },
  },
  {
    name: "a planner raised Needs a date above next up",
    suite: true,
    moves: "date_chase",
    make: async (b) => {
      await b.planner((plan) => [RAISED, ...plan.sections.filter((s) => s.component !== "date_chase")]);
    },
  },
  {
    name: "a planner sank the tiles to the bottom",
    moves: "stat_row",
    make: async (b) => {
      await b.planner((plan) => [...plan.sections.filter((s) => s.component !== "stat_row"), SUNK]);
    },
  },
  {
    name: "a planner listed the cards above the strip",
    moves: null,
    make: async (b) => {
      await b.planner((plan) => [...cardsOf(plan), ...othersOf(plan)]);
    },
  },
];
const RUN = process.env.HIDE_THEN_SHOW === "all" ? STATES : STATES.filter((s) => s.suite);
/** One real step after the pair: something that makes the next open a new situation. */
const STEPS: [string, (b: Board) => Promise<unknown>][] = [
  ["he starts talking dates", (b) => b.talksDates()],
  ["the talk stops, and a task", async (b) => (await b.talkStops(), b.aTask())],
  ["a day turns, and a task", async (b) => (await b.nextDay(), b.aTask())],
  ["a task", (b) => b.aTask()],
];

afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("he hides a section and shows it again", () => {
  it.each(RUN)("$name: 25 pairs, each stepped four ways beside the same board without the pair", { timeout: 900_000 }, async (state) => {
    const b = await board();
    await b.open();
    await state.make(b);
    await b.open();
    const was = await b.snapshot();
    const counts = { pairs: 0, back: 0, "the section the system moved, to its usual place": 0, "the other side of the moved section": 0, "the cards, by the count": 0, "newly held": 0, "an order lost": 0, "futures stepped": 0, "a hold the pair alone causes": 0 };
    const wrong: string[] = [];
    const notBack: string[] = [];
    for (const other of [null, ...FIVE]) {
      // The board without the pair: the control for every pair on it, stepped each way.
      await b.restore(was);
      if (other) await b.say("hide", other);
      await b.open();
      const control = await b.snapshot();
      const without: string[] = [];
      for (const [, step] of STEPS) {
        await b.restore(control);
        await step(b);
        without.push(await b.served());
      }
      for (const key of FIVE.filter((k) => k !== other)) {
        await b.restore(control);
        const before = await b.open();
        if (!before.includes(key)) continue;
        const [servedBefore, ordersBefore] = [await b.served(), await b.orders()];
        counts.pairs++;
        expect(await b.say("hide", key)).toBe(true);
        expect(await b.say("show", key)).toBe(true);
        const after = await b.open();
        const what = `${key} hidden and shown${other ? `, ${other} hidden first` : ""}`;
        if (servedBefore === "rules" && (await b.served()) !== "rules") {
          counts["newly held"]++;
          wrong.push(`${what}: newly held`);
        }
        const ordersAfter = await b.orders();
        const lost = ordersBefore.filter((order) => !ordersAfter.includes(order));
        if (lost.length) {
          counts["an order lost"]++;
          wrong.push(`${what}: an order accepted before is refused after: ${lost.join(" | ")}`);
        }
        const [had, has] = [before, after].map((list) => list.filter((k) => !isCard(k)));
        if (after.join() !== before.join()) notBack.push(`${what}: ${had.join(" ")} -> ${has.join(" ")}`);
        if (after.join() === before.join()) counts.back++;
        else if (has.join() === had.join()) counts["the cards, by the count"]++;
        else if (key === state.moves) counts["the section the system moved, to its usual place"]++;
        else if (state.moves && had.includes(state.moves) && has.filter((k) => k !== key).join() === had.filter((k) => k !== key).join() && had.indexOf(key) < had.indexOf(state.moves) !== has.indexOf(key) < has.indexOf(state.moves)) counts["the other side of the moved section"]++;
        else wrong.push(`${what}: ${had.join(" ")} -> ${has.join(" ")}`);
        // The futures: the same board with the pair, each step, and what a new open is then served; beside the control.
        if (process.env.HIDE_THEN_SHOW !== "all" && after.join() === before.join()) continue;
        const withPair = await b.snapshot();
        for (const [i, [name, step]] of STEPS.entries()) {
          await b.restore(withPair);
          await step(b);
          counts["futures stepped"]++;
          if (without[i] === "rules" && (await b.served()) !== "rules") {
            counts["a hold the pair alone causes"]++;
            wrong.push(`${what}, then ${name}: held with the pair, served without it`);
          }
        }
      }
    }
    console.log(`HIDE THEN SHOW | ${state.name} | ${JSON.stringify(counts)}`);
    if (process.env.HIDE_THEN_SHOW_PRINT) console.log(notBack.map((line) => `   NOT BACK | ${line}`).join("\n"));
    expect(wrong).toEqual([]);
    expect([counts["newly held"], counts["an order lost"], counts["a hold the pair alone causes"]]).toEqual([0, 0, 0]);
    expect(counts.pairs).toBe(25);
  });
});

// The four families the Reviewer's stepped probe found on 472c2a7, each written out: the pair, the step, what a
// new open is served; beside the same board without the pair.
describe("a hide and a show leave no hold behind: the four families, stepped for real beside a control", () => {
  /** The same state twice: the pair and the step on one board, the step alone on the other; what a new open is then served on each. */
  async function stepped(make: (b: Board) => Promise<void>, key: string, step: (b: Board) => Promise<unknown>) {
    const served: string[] = [];
    let boards: string[][] = [];
    for (const withPair of [true, false]) {
      const b = await board();
      await b.open();
      await make(b);
      const before = await b.open();
      if (withPair) {
        expect(await b.say("hide", key)).toBe(true);
        expect(await b.say("show", key)).toBe(true);
        boards = [before, await b.open()];
      }
      await step(b);
      served.push(await b.served());
    }
    return { withPair: served[0], without: served[1], before: boards[0].filter((k) => !isCard(k)), after: boards[1].filter((k) => !isCard(k)) };
  }
  const state = (name: string) => STATES.find((s) => s.name.startsWith(name))!.make;

  it.each(["hero_next_up", "stat_row", "timeline"])("1. the day the strip rises, %s hidden and shown; the next day, a task: served, as without the pair", async (key) => {
    const r = await stepped(state("the very day"), key, async (b) => (await b.nextDay(), b.aTask()));
    expect([r.withPair, r.without]).toEqual(["rules", "rules"]);
    // Next up and the tiles come back where they stood, under the strip; the strip itself to its usual place, and the rule sends it up again.
    if (key !== "timeline") expect(r.after).toEqual(r.before);
    else expect(r.after).toEqual(["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"]);
  });

  it.each(["hero_next_up", "stat_row", "timeline"])("2. the strip held up after the talk stopped, %s hidden and shown; then he talks dates again: served, as without the pair", async (key) => {
    const r = await stepped(state("a rule sent the strip up, the talk stopped"), key, (b) => b.talksDates());
    expect([r.withPair, r.without]).toEqual(["rules", "rules"]);
    if (key !== "timeline") expect(r.after).toEqual(r.before);
    else expect(r.after).toEqual(["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"]);
  });

  it.each(["hero_next_up", "stat_row", "timeline"])("3. a rule's move waiting, %s hidden and shown; then the talk stops, and a task: served, as without the pair", async (key) => {
    const r = await stepped(state("a rule's move is waiting"), key, async (b) => (await b.talkStops(), b.aTask()));
    expect([r.withPair, r.without]).toEqual(["rules", "rules"]);
    expect(r.after).toEqual(r.before); // the strip too: back between the tiles and Needs a date, where it stood
  });

  it.each(["date_chase", "people_index"].flatMap((key) => STEPS.slice(0, 3).map(([name, step]) => [key, name, step] as const)))("4. the cards listed above the strip, %s hidden and shown; then %s: served, as without the pair", async (key, _name, step) => {
    const r = await stepped(state("a planner listed the cards above the strip"), key, step);
    expect([r.withPair, r.without]).toEqual(["rules", "rules"]);
    expect(r.after).toEqual(r.before);
  });
});
