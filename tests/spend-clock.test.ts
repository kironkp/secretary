// docs/spend/SPEC.md §4 (v1.04, item 5): a row written because of a change
// that is already known is not a new situation. The signals hash carried the
// layout clock as a raw day count, and every stored plan that changes the
// board's order resets that clock; so the row that answered a situation
// changed the hash it had just been stored under, and the next open asked
// the planner again. Counted here, with a planner that answers every time it
// is asked: what one change costs in planner calls, at the opens that follow
// it the same day and on the days after.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, layoutSpecs, messages, projects, tasks, user } from "@/lib/db/schema";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, hashOnceStored, persistPlan } from "@/lib/layout/plan-store";
import { REGISTRY_VERSION } from "@/lib/layout/registry";
import { computeSignals, signalsHash, type Signals } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
type Answer = (signals: Signals, rendered: LayoutPlan) => LayoutPlan;
/** The planner agrees with what the rules made: its answer changes nothing. */
const agrees: Answer = (_signals, rendered) => rendered;
/** The planner adds a banner. */
const banner: Answer = (signals) => {
  const plan = defaultPlan(signals);
  return { ...plan, plan_id: "p", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Two things are late", tone: "serious" } }, ...plan.sections] };
};
/** The planner sends the strip to the top, opened, and says why. */
const movesTheStrip: Answer = (signals) => {
  const plan = defaultPlan(signals);
  const rest = plan.sections.filter((s) => s.component !== "timeline");
  return { ...plan, plan_id: "p", reason_summary: "Dates first", sections: [{ component: "timeline", props: { span_days: 14, expanded: true }, why: "Dates first this week" }, ...rest] };
};

async function board() {
  const id = `test-clock-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Clock", email: `${id}@v104.test`, timezone: TZ });
  const ids: Record<string, string> = {};
  for (const [name, due] of [["Atlas", -3], ["Birch", null], ["Cedar", null]] as const) {
    const [p] = await db.insert(projects).values({ userId: id, name, status: "active" }).returning();
    ids[name] = p.id;
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: due === null ? null : new Date(Date.now() + due * 86_400_000) });
  }
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  let calls = 0;
  return {
    id,
    ids,
    /** One open of the Dashboard: the render, then the store and the background planner. */
    open: async (answer: Answer) => {
      const bundle = await computeCurrentPlan(id);
      await persistPlan(id, bundle, {
        call: async () => {
          calls++;
          lastPlannerUsage.model = "claude-sonnet-5";
          lastPlannerUsage.input = 4_000;
          lastPlannerUsage.output = 800;
          return JSON.stringify(answer(bundle.signals, bundle.plan));
        },
      });
      return bundle;
    },
    calls: () => calls,
    forget: () => (calls = 0),
    arrange: (operations: { op: string; section: string }[]) => executeTool(ctx, "arrange_dashboard", { operations }),
    /** A day goes by: every stored plan is a day older. A new process too. */
    nextDay: async () => {
      await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '25 hours'` }).where(eq(layoutSpecs.userId, id));
      clearPlanCache();
    },
    /** Something changes in his data. */
    newTask: (project: string) => db.insert(tasks).values({ userId: id, projectId: ids[project], title: `${project}: another ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken" }),
    keys: async () => ((await getPlanHead(id))!.spec as LayoutPlan).sections.map(sectionKey),
  };
}
/** A board that has been opened, and settled, some days ago. */
async function settled() {
  const b = await board();
  await b.open(agrees);
  await b.nextDay();
  await b.nextDay();
  await b.open(agrees);
  b.forget();
  return b;
}

beforeEach(() => clearPlanCache());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("what one change costs in planner calls", { timeout: 30_000 }, () => {
  it("a settled board opened again and again, and on later days: none", async () => {
    const b = await settled();
    for (let day = 0; day < 4; day++) {
      await b.open(agrees);
      await b.open(agrees);
      await b.nextDay();
    }
    expect(b.calls()).toBe(0);
  });

  it.each([
    ["a card", { op: "move_to_top", section: "Cedar" }],
    ["a section that is not a card", { op: "move_to_top", section: "needs a date" }],
  ])("his own move of %s: none, at the opens that follow or on the days after", async (_what, op) => {
    const b = await settled();
    expect((await b.arrange([op])).result).toMatchObject({ applied: true });
    const sameDay = [];
    for (let open = 0; open < 3; open++) {
      const bundle = await b.open(agrees);
      sameDay.push(bundle.wantsLlmRefinement);
    }
    expect(sameDay).toEqual([false, false, false]);
    expect(b.calls()).toBe(0);

    const perDay: number[] = [];
    for (let day = 1; day <= 4; day++) {
      await b.nextDay();
      const before = b.calls();
      await b.open(agrees);
      await b.open(agrees);
      perDay.push(b.calls() - before);
    }
    // v1.04 had [1, 0, 0, 0]: his move reset the layout clock, and the clock
    // turning over a day later was a new situation. Since v1.02 r5 the clock
    // is the system's own (what he placed is not counted), so his move
    // leaves it alone and no later day is new.
    expect(perDay).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ["adds a banner", banner, "focus_banner"],
    ["moves a section", movesTheStrip, "timeline"],
  ])("a planner answer that %s: the one call that produced it, however often the Dashboard is opened that day", async (_what, answer, first) => {
    const b = await settled();
    await b.newTask("Birch"); // a new situation: this is the one the planner is asked about
    await b.open(answer);
    expect(b.calls()).toBe(1);
    expect((await b.keys())[0]).toBe(first);
    for (let open = 0; open < 3; open++) {
      const bundle = await b.open(answer);
      expect(bundle.wantsLlmRefinement, `open ${open + 2}`).toBe(false);
      expect(bundle.plan.sections.map(sectionKey)[0], `open ${open + 2}`).toBe(first);
    }
    expect(b.calls()).toBe(1);
  });

  it("the rules themselves move a section (he has been asking about dates): that open's one call, none at the next", async () => {
    const b = await settled();
    const [conv] = await db.insert(conversations).values({ userId: b.id, mode: "text" }).returning();
    await db.insert(messages).values(Array.from({ length: 4 }, (_, i) => ({ userId: b.id, conversationId: conv.id, role: "user" as const, content: `when is the deadline? (${i})`, mode: "text" as const })));
    const first = await b.open(agrees);
    // The render's own plan moved the strip to the top: the row it is stored in resets the clock.
    expect(first.plan.sections[0].component).toBe("timeline");
    expect(b.calls()).toBe(1);
    for (let open = 0; open < 3; open++) expect((await b.open(agrees)).wantsLlmRefinement, `open ${open + 2}`).toBe(false);
    expect(b.calls()).toBe(1);
  });

  it("a planner that writes a banner every time it is asked, nothing else changing: after the first day, no call on any day", async () => {
    // What a real planner does while things are late. Before v1.02 r5 this
    // was one paid call a day for ever: the banner's row reset the layout
    // clock, the clock turning over a day later was a new hash, the rules
    // took the banner off at that open and the planner put it back. The
    // banner is not a change of order: it does not count for the clock.
    const b = await settled();
    await b.newTask("Birch");
    await b.open(banner);
    expect(b.calls()).toBe(1);
    const perDay: number[] = [];
    for (let day = 1; day <= 4; day++) {
      await b.nextDay();
      const before = b.calls();
      for (let open = 0; open < 3; open++) {
        const bundle = await b.open(banner);
        expect(bundle.plan.sections[0].component, `day ${day}, open ${open + 1}`).toBe("focus_banner");
      }
      perDay.push(b.calls() - before);
    }
    expect(perDay).toEqual([0, 0, 0, 0]);
    // The same with a planner that would have nothing to add: nobody asks it.
    const c = await settled();
    await c.newTask("Birch");
    await c.open(banner);
    const quiet: number[] = [];
    for (let day = 1; day <= 4; day++) {
      await c.nextDay();
      const before = c.calls();
      for (let open = 0; open < 2; open++) await c.open(agrees);
      quiet.push(c.calls() - before);
    }
    expect(quiet).toEqual([0, 0, 0, 0]);
  });

  it("the banner the planner wrote today stays today when his data changes (invariant 8), with the one call a new situation costs", async () => {
    const b = await settled();
    await b.newTask("Birch");
    await b.open(banner);
    const before = b.calls();
    await b.newTask("Cedar");
    const bundle = await b.open(banner);
    expect(bundle.plan.sections[0].component).toBe("focus_banner"); // not taken off by the rules plan, which has none
    expect(b.calls() - before).toBe(1);
  });
});

describe("the layout clock reads the day, not the newest ten rows", () => {
  const spec = (order: string[], why: string): LayoutPlan => ({ plan_id: "x", reason_summary: null, sections: order.map((component) => ({ component, ...(component === "stat_row" ? { why } : {}) })) });
  it("a change of layout today is still today's after ten more rows are stored the same day", async () => {
    // On main the clock read the newest ten stored rows. Ten rows later the
    // same day (a why that changes, his own requests) the row that changed
    // the layout was out of sight, the clock read "never", the hash turned
    // over and the system was free to reorder again the same day.
    const id = `test-clock-${crypto.randomUUID()}`;
    users.push(id);
    await db.insert(user).values({ id, name: "Clock", email: `${id}@v102.test`, timezone: TZ });
    const row = (version: number, plan: LayoutPlan, ageHours: number) =>
      db.insert(layoutSpecs).values({ userId: id, version, spec: plan, pinned: [], kind: "plan", signalsHash: "h", outcome: "accepted", createdAt: new Date(Date.now() - ageHours * 3_600_000) });
    const usual = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
    const stripUp = ["timeline", "hero_next_up", "stat_row", "date_chase", "people_index"];
    await row(1, spec(usual, "a"), 80); // three days ago
    await row(2, spec(stripUp, "a"), 3); // the system moved the strip, three hours ago
    const clock = async () => (await computeSignals(id)).context.days_since_layout_change;
    expect(await clock()).toBe(0);
    for (let n = 0; n < 14; n++) {
      await row(3 + n, spec(stripUp, `mentioned ${n} times`), 2 - n / 10);
      expect(await clock(), `after ${n + 1} more rows`).toBe(0);
    }
    // And it does turn over when a day has gone by (how many days is not read
    // by anything: the rules and the hash ask only whether it is one or more).
    await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
    expect(await clock()).toBeGreaterThanOrEqual(1);
  });
});

describe("the hash", () => {
  const signals = (days: number): Signals =>
    ({
      projects: [],
      engagement: {},
      conversation: { schedule_word_share: 0, questions_today: [] },
      context: { days_since_layout_change: days, pinned_sections: [], calm_mode: false },
      pending: { items_missing_dates: [] },
      calendar: { next_hard_commitment: null },
    }) as unknown as Signals;

  it("carries whether a reorder is allowed yet, not the number of days", () => {
    const h = (days: number) => signalsHash(signals(days), REGISTRY_VERSION);
    expect(h(0)).not.toBe(h(1));
    expect(h(1)).toBe(h(2));
    expect(h(2)).toBe(h(40));
    expect(h(40)).toBe(h(3650));
  });

  it("a plan that changes the order is stored under the hash with the clock reset; one that does not, under the hash as it is", () => {
    const a: LayoutPlan = { plan_id: "a", reason_summary: null, sections: [{ component: "hero_next_up" }, { component: "stat_row" }] };
    const emphasised: LayoutPlan = { ...a, sections: [{ component: "hero_next_up" }, { component: "stat_row", why: "Look here" }] };
    const reordered: LayoutPlan = { ...a, sections: [{ component: "stat_row" }, { component: "hero_next_up" }] };
    const now = signalsHash(signals(5), REGISTRY_VERSION);
    const reset = signalsHash(signals(0), REGISTRY_VERSION);
    expect(hashOnceStored(signals(5), emphasised, { spec: a, pinned: [] }, [])).toBe(now);
    expect(hashOnceStored(signals(5), reordered, { spec: a, pinned: [] }, [])).toBe(reset);
    expect(hashOnceStored(signals(5), a, null, [])).toBe(now); // the first plan ever stored has nothing before it
    expect(hashOnceStored(signals(0), reordered, { spec: a, pinned: [] }, [])).toBe(reset);
    // The pins are in the hash, and a row is stored with its own.
    const pinned = signals(5);
    pinned.context.pinned_sections = ["stat_row"];
    expect(hashOnceStored(signals(5), emphasised, { spec: a, pinned: [] }, ["stat_row"])).toBe(signalsHash(pinned, REGISTRY_VERSION));
    expect(hashOnceStored(signals(5), emphasised, { spec: a, pinned: [] }, ["stat_row"])).not.toBe(now);
  });
});
