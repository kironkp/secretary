// SPEC §2 (v1.02 r5), the guard: his request leaves no hold. Before it
// writes, a request asks two things of the board he is about to be told,
// against the board as it is: what a new open would be served today; and
// each order the rules can produce, the clock a day on. The rules plan served
// now and held after, or an order accepted now and refused after, is a hold.
// With the rules as they are the guard never fires: a section takes its place
// in an order that is accepted, and taking a section off the board refuses
// none. It can fire only if a rule ever SINKS a section with a reason, so
// this file makes such a rule: the tiles sent to the bottom, with a reason,
// as today's rules plan, as the one order the rules can produce, or both. It
// shows the other places tried in order and the first good one taken, nothing
// logged; a request that brings nothing back applied all the same, with one
// line in the server log, for each of the two questions alone; and where the
// guard is not asked at all.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * The made rule, as today's rules plan (`today`) and as the one order the rules can produce (`anyDay`). `raised`: a
 * second made rule instead, for the one thing the first cannot show (two good places): the tiles and Needs a date
 * both raised above next up, each with a reason.
 */
const made = vi.hoisted(() => ({ today: false, anyDay: false, raised: false }));
vi.mock("@/lib/layout/plan-from-rules", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/layout/plan-from-rules")>();
  type Plan = ReturnType<typeof real.planFromRules>;
  const tiles = { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" };
  const dates = { component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" };
  const madeOf = (plan: Plan): Plan => {
    const rest = plan.sections.filter((s) => s.component !== "stat_row" && (!made.raised || s.component !== "date_chase"));
    return { ...plan, plan_id: "rules-made", sections: made.raised ? [{ ...tiles, why: "The numbers first today" }, dates, ...rest] : [...rest, tiles] };
  };
  return {
    ...real,
    planFromRules: (signals: Parameters<typeof real.planFromRules>[0]) => (made.today ? madeOf(real.planFromRules(signals)) : real.planFromRules(signals)),
    ordersTheRulesCanProduce: (signals: Parameters<typeof real.planFromRules>[0]) => (made.anyDay ? [madeOf(real.ordersTheRulesCanProduce(signals)[0])] : real.ordersTheRulesCanProduce(signals)),
  };
});
const theTilesSink = (on: boolean) => {
  made.today = on;
  made.anyDay = on;
};

import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import { requestBoard } from "@/lib/layout/request";
import { computeSignals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
const isCard = (k: string) => k.startsWith("project_card:");

async function board() {
  const id = `test-guard-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Guard", email: `${id}@v102.test`, timezone: TZ });
  for (const [i, name] of ["Atlas", "Birch", "Cedar"].entries()) {
    const [p] = await db.insert(projects).values({ userId: id, name, kind: "project", status: "active" }).returning();
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: i === 0 ? new Date(Date.now() - 2 * 86_400_000) : null });
  }
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const open = async () => {
    const bundle = await computeCurrentPlan(id);
    await persistPlan(id, bundle);
    // The cards as one word: where the run stands is what matters here.
    return bundle.plan.sections.map(sectionKey).map((k) => (isCard(k) ? "cards" : k)).filter((k, i, all) => k !== "cards" || all[i - 1] !== "cards");
  };
  return {
    id,
    open,
    say: async (operations: { op: string; section: string }[]) => (await executeTool(ctx, "arrange_dashboard", { operations })).result as { applied?: boolean; error?: string },
    /** What a new open would be served: the chain an open runs when the stored row is not served again. */
    served: async () => {
      const head = (await getPlanHead(id))!;
      return (await planWithFallback(await computeSignals(id), { previousPlan: head.spec as LayoutPlan, preferences: await getPreferences(id), pinnedSections: head.pinned, llmEnabled: false })).source;
    },
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearPlanCache();
  theTilesSink(false);
  made.raised = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the guard, with a rule made for the purpose (the tiles sunk to the bottom, with a reason)", () => {
  it("one request takes People off and brings Needs a date back: it comes back behind the cards, the made order still stands, and nothing is logged", async () => {
    const b = await board();
    await b.open();
    expect((await b.say([{ op: "hide", section: "needs a date" }])).applied).toBe(true);
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "timeline", "cards", "people_index"]);
    theTilesSink(true);
    // The made rule's move is waiting: the rules plan is served (the tiles moved, with their reason), not held.
    expect(await b.served()).toBe("rules");
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "timeline", "cards", "people_index"]);
    // With People gone, the tiles and the strip tie for which is out of step, and the validator reads the strip as
    // moved (it stands later, and has no reason): the made order is refused against the list, no order is
    // accepted, and by today's order Needs a date goes under next up, its section in step. But it has the cards
    // above it, and the side of the cards wins: behind the cards, last. Against that board the made order is still
    // accepted, and the guard has nothing to do. (Until the cards counted as a section of the order it came back
    // directly under next up, and the guard had to try three places.)
    const reply = await b.say([
      { op: "hide", section: "people" },
      { op: "show", section: "needs a date" },
    ]);
    expect(reply.applied).toBe(true);
    const told = await b.open();
    expect(told).toEqual(["hero_next_up", "stat_row", "timeline", "cards", "date_chase"]);
    expect(await b.served()).toBe("rules");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the first other place tried would hold the plan too: the next is tried, and taken, and nothing is logged", async () => {
    // The strip is hidden. The made rule's move of the tiles is waiting. In one request he hides People and shows
    // the strip. With People gone the tiles and Needs a date tie, no order is accepted, and by today's order the
    // strip goes under next up: next up, the strip, the tiles, Needs a date. Against that the made order (the
    // strip, Needs a date, then the tiles) is refused: a hold. The other places, nearest first: on top (refused:
    // two sections out of step), then under the tiles: next up, the tiles, the strip, Needs a date, where only the
    // tiles are read as moved, and they carry the reason. Taken.
    const b = await board();
    await b.open();
    expect((await b.say([{ op: "hide", section: "project progress" }])).applied).toBe(true);
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "cards", "date_chase", "people_index"]);
    theTilesSink(true);
    expect(await b.served()).toBe("rules");
    const reply = await b.say([
      { op: "hide", section: "people" },
      { op: "show", section: "project progress" },
    ]);
    expect(reply.applied).toBe(true);
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "timeline", "cards", "date_chase"]);
    expect(await b.served()).toBe("rules");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the place the guard finds is settled like any other: a card of his among the cards keeps its neighbour when the cards move", async () => {
    // The second made rule, as in the test below: People is tried under the tiles, above the cards, and taken. The
    // count then puts the cards above People; his card, second among them, goes with the card it stood under.
    const b = await board();
    await b.open();
    expect((await b.say([{ op: "hide", section: "people" }])).applied).toBe(true);
    const keys = async () => (await computeCurrentPlan(b.id)).plan.sections.map(sectionKey);
    const cards = (await keys()).filter(isCard);
    expect((await requestBoard(b.id, { ops: [{ op: "pin", key: cards[1] }] })).ok).toBe(true);
    made.raised = true;
    theTilesSink(true);
    expect(await b.served()).toBe("rules");
    const reply = await b.say([
      { op: "hide", section: "project progress" },
      { op: "show", section: "people" },
    ]);
    expect(reply.applied).toBe(true);
    const after = await keys();
    expect(after).toEqual(["hero_next_up", "stat_row", ...cards, "people_index", "date_chase"]);
    expect(((await getPlanHead(b.id))!.pinned)).toEqual([cards[1]]);
    expect(await b.served()).toBe("rules");
    expect(warn).not.toHaveBeenCalled();
  });

  it("two places would do: the nearer one to the rule's place is taken", async () => {
    // The second made rule: the tiles and Needs a date raised above next up, each with a reason. He has People
    // hidden; he hides the strip and shows People in one request. By the made order People goes under Needs a
    // date, last: refused. Of the places that would do, under next up and under the tiles, the nearer is under
    // the tiles.
    const b = await board();
    await b.open();
    expect((await b.say([{ op: "hide", section: "people" }])).applied).toBe(true);
    made.raised = true;
    theTilesSink(true);
    expect(await b.served()).toBe("rules");
    const reply = await b.say([
      { op: "hide", section: "project progress" },
      { op: "show", section: "people" },
    ]);
    expect(reply.applied).toBe(true);
    expect((await b.open()).filter((k) => k !== "cards")).toEqual(["hero_next_up", "stat_row", "people_index", "date_chase"]);
    expect(await b.served()).toBe("rules");
    expect(warn).not.toHaveBeenCalled();
  });

  const LINE = "[layout] a request leaves the rules plan held, now or on a later day: 1 operation(s), 0 section(s) brought back, 0 other place(s) tried";
  it.each([
    ["today's rules plan and the order the rules can produce", true, true],
    ["today's rules plan alone (no order the rules can produce is lost)", true, false],
    ["an order the rules can produce alone (today's rules plan is still served)", false, true],
  ])("a request that brings nothing back and would leave a hold is applied all the same, with one line in the server log, counts only: %s", async (_what, today, anyDay) => {
    const b = await board();
    await b.open();
    await b.say([{ op: "hide", section: "needs a date" }]);
    made.today = today;
    made.anyDay = anyDay;
    expect(await b.served()).toBe("rules");
    const reply = await b.say([{ op: "hide", section: "people" }]);
    expect(reply.applied).toBe(true);
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "timeline", "cards"]);
    expect(await b.served()).toBe(today ? "previous" : "rules");
    expect(warn.mock.calls).toEqual([[LINE]]);
  });

  it("where the plan is held before he speaks, the guard is not asked: nothing is tried and nothing logged", async () => {
    const b = await board();
    await b.open();
    await b.say([{ op: "hide", section: "needs a date" }]);
    theTilesSink(true);
    await b.say([{ op: "hide", section: "people" }]);
    expect(await b.served()).toBe("previous");
    warn.mockClear();
    expect((await b.say([{ op: "show", section: "needs a date" }])).applied).toBe(true);
    expect((await b.say([{ op: "hide", section: "next up" }])).applied).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a request that is refused logs nothing, whatever it would have done to the plan", async () => {
    const b = await board();
    await b.open();
    await b.say([{ op: "hide", section: "needs a date" }]);
    theTilesSink(true);
    // People off (which would hold the plan) and, in the same request, something that is not on the board hidden: refused.
    const reply = await b.say([
      { op: "hide", section: "people" },
      { op: "hide", section: "needs a date" },
    ]);
    expect(reply.applied).not.toBe(true);
    expect(await b.open()).toEqual(["hero_next_up", "stat_row", "timeline", "cards", "people_index"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("in calm mode no plan is asked for, so the guard is not asked either", async () => {
    const b = await board();
    await b.open();
    await b.say([{ op: "hide", section: "needs a date" }]);
    await db.update(user).set({ calmMode: true }).where(eq(user.id, b.id));
    await b.open();
    theTilesSink(true);
    expect((await b.say([{ op: "hide", section: "people" }])).applied).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the guard is not asked for Put it back", () => {
  it("Put it back onto a board the rules plan is refused against: it is his to put back, and nothing is logged", async () => {
    const b = await board();
    await b.open();
    await b.say([{ op: "hide", section: "needs a date" }]);
    theTilesSink(true);
    // People made his: the system's sections are next up, the tiles and the strip, and the made rule's plan is held (logged, once).
    expect((await requestBoard(b.id, { ops: [{ op: "pin", key: "people_index" }] })).ok).toBe(true);
    expect(await b.served()).toBe("previous");
    expect(warn).toHaveBeenCalledTimes(1);
    // Put it back: People is the system's again, and the plan is served.
    expect((await requestBoard(b.id, { revert: true })).ok).toBe(true);
    expect(((await getPlanHead(b.id))!.pinned)).toEqual([]);
    expect(await b.served()).toBe("rules");
    warn.mockClear();
    // And once more (a redo): the board with People his again. The plan is held again, by his own doing, and that is not the guard's to report.
    expect((await requestBoard(b.id, { revert: true })).ok).toBe(true);
    expect(((await getPlanHead(b.id))!.pinned)).toEqual(["people_index"]);
    expect(await b.served()).toBe("previous");
    expect(warn).not.toHaveBeenCalled();
  });
});
